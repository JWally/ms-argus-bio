import * as path from 'path';
import { fileURLToPath } from 'url';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CheckoutStackProps extends StackProps {
  bioApiUrl: string;
  bioApiSecret: string;
  domainName: string; // e.g. checkout.wolcott.io
  hostedZoneDomain: string; // e.g. wolcott.io
  hostedZoneId: string;
}

export class CheckoutStack extends Stack {
  constructor(scope: Construct, id: string, props: CheckoutStackProps) {
    super(scope, id, props);

    const { bioApiUrl, bioApiSecret, domainName, hostedZoneDomain, hostedZoneId } = props;

    // ── DNS & Certificate ──────────────────────────────────────────────
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId,
      zoneName: hostedZoneDomain,
    });

    const certificate = new acm.Certificate(this, 'Cert', {
      domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ── Lambda (session proxy) ─────────────────────────────────────────
    const fn = new lambda.NodejsFunction(this, 'CheckoutHandler', {
      entry: path.join(__dirname, '..', '..', '..', 'checkout', 'handler.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(10),
      environment: {
        BIO_API_URL: bioApiUrl,
        BIO_API_SECRET: bioApiSecret,
        RETURN_URL: `https://${domainName}`,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
      },
    });

    // ── API Gateway ────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: [`https://${domainName}`],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });

    api.addRoutes({
      path: '/api/session',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SessionIntegration', fn),
    });

    // ── S3 bucket (static site) ────────────────────────────────────────
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ── CloudFront ─────────────────────────────────────────────────────
    const apiOrigin = new origins.HttpOrigin(
      `${api.apiId}.execute-api.${this.region}.amazonaws.com`
    );

    const distribution = new cloudfront.Distribution(this, 'CDN', {
      domainNames: [domainName],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
    });

    // ── Deploy static files ────────────────────────────────────────────
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', '..', 'checkout'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      exclude: ['*.ts'],
    });

    // ── DNS record ─────────────────────────────────────────────────────
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
    });

    // ── Lambda warmer ──────────────────────────────────────────────────
    new events.Rule(this, 'WarmerRule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(fn)],
    });

    // ── Outputs ────────────────────────────────────────────────────────
    new CfnOutput(this, 'SiteUrl', { value: `https://${domainName}` });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint! });
  }
}
