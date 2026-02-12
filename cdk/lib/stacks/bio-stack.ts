// cdk/lib/stacks/bio-stack.ts
// Main CDK stack for ms-argus-bio classification API

import * as path from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import * as cdk from "aws-cdk-lib";
import {
  Stack,
  StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
} from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { createVectorLambdaConfig, createPowertoolsEnv } from "../constructs/lambda-config";

export interface BioStackProps extends StackProps {
  stage: string;
  environment: string;
  vectorEnvironment: string;
  rootDomain: string;
}

export class BioStack extends Stack {
  constructor(scope: Construct, id: string, props: BioStackProps) {
    super(scope, id, props);

    const { stage, environment, vectorEnvironment, rootDomain } = props;
    const stackName = this.stackName;

    // Compute domain names
    const apiSubdomain = stage === "prod" ? "api-bio" : `api-bio-${environment}`;
    const siteSubdomain = stage === "prod" ? "bio" : `bio-${environment}`;
    const apiDomainName = `${apiSubdomain}.${rootDomain}`;
    const siteDomainName = `${siteSubdomain}.${rootDomain}`;

    // =========================================================================
    // CROSS-STACK IMPORTS (via SSM Parameter Store)
    // =========================================================================

    // VPC from ms-argus-infra
    const vpcId = ssm.StringParameter.valueFromLookup(
      this,
      `/argus/${vectorEnvironment}/vpc-id`,
    );
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { vpcId });

    // Qdrant connection from ms-argus-vector
    const vectorSsmPrefix = `/argus-vector/${vectorEnvironment}`;
    const qdrantUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `${vectorSsmPrefix}/qdrant-url`,
    );
    const qdrantSecretArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${vectorSsmPrefix}/qdrant-secret-arn`,
    );

    // =========================================================================
    // DNS & CERTIFICATES
    // =========================================================================

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: rootDomain,
    });

    const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: apiDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const siteCertificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: siteDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // =========================================================================
    // LAMBDA SECURITY GROUP
    // =========================================================================

    const lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc,
      securityGroupName: `${stackName}-lambda-sg`,
      description: "Security group for bio classify Lambda",
      allowAllOutbound: true,
    });

    // =========================================================================
    // CLOUDWATCH LOG GROUP
    // =========================================================================

    const logGroup = new logs.LogGroup(this, "ClassifyLogGroup", {
      logGroupName: `/aws/lambda/${stackName}-classify`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // LAMBDA FUNCTION
    // =========================================================================

    const classifyFn = new lambda.NodejsFunction(this, "ClassifyHandler", {
      ...createVectorLambdaConfig(),
      entry: path.join(__dirname, "../../../server/handler.ts"),
      handler: "handler",
      functionName: `${stackName}-classify`,
      memorySize: 256,
      timeout: Duration.seconds(30),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      logGroup,
      environment: {
        ...createPowertoolsEnv("bio-classify", stackName),
        QDRANT_URL: qdrantUrl,
        QDRANT_SECRET_ARN: qdrantSecretArn,
        STAGE: stage,
      },
    });

    // Grant Secrets Manager access for Qdrant API key
    classifyFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["arn:aws:secretsmanager:*:*:secret:argus-vector/*"],
      }),
    );

    // =========================================================================
    // HTTP API GATEWAY
    // =========================================================================

    const httpApi = new apigatewayv2.HttpApi(this, "BioApi", {
      apiName: `${stackName}-api`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["Content-Type"],
        maxAge: Duration.hours(1),
      },
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "ClassifyIntegration",
      classifyFn,
    );

    httpApi.addRoutes({
      path: "/v1/classify",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: "/health",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: "/admin/flush",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: "/admin/stats",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // =========================================================================
    // API CLOUDFRONT
    // =========================================================================

    // httpApi.url is a CDK token — extract domain with Fn.split (token-safe)
    const apiGatewayDomain = cdk.Fn.select(
      2,
      cdk.Fn.split("/", httpApi.url!),
    );

    const apiDistribution = new cloudfront.Distribution(this, "ApiDistribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiGatewayDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      domainNames: [apiDomainName],
      certificate: apiCertificate,
      comment: `${stackName} - Bio API`,
    });

    new route53.ARecord(this, "ApiDnsRecord", {
      zone: hostedZone,
      recordName: apiDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(apiDistribution),
      ),
    });

    // =========================================================================
    // STATIC SITE (S3 + CloudFront)
    // =========================================================================

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "SiteOAI");
    siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [siteBucket.arnForObjects("*")],
        principals: [
          new iam.CanonicalUserPrincipal(
            oai.cloudFrontOriginAccessIdentityS3CanonicalUserId,
          ),
        ],
      }),
    );

    // Cache policies
    const staticAssetsCachePolicy = new cloudfront.CachePolicy(
      this,
      "StaticAssetsCachePolicy",
      {
        cachePolicyName: `${stackName}-static-assets-cache`,
        comment: "Cache policy for static assets with compression",
        defaultTtl: Duration.days(30),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      },
    );

    const htmlCachePolicy = new cloudfront.CachePolicy(this, "HtmlCachePolicy", {
      cachePolicyName: `${stackName}-html-no-cache`,
      comment: "No cache policy for HTML files with compression",
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(1),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const s3Origin = new origins.S3Origin(siteBucket, {
      originAccessIdentity: oai,
    });

    const siteDistribution = new cloudfront.Distribution(
      this,
      "SiteDistribution",
      {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: htmlCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        additionalBehaviors: Object.fromEntries(
          ["*.js", "*.css", "*.woff*", "*.png", "*.jpg", "*.svg", "*.wasm", "model/*"].map(
            (pattern) => [
              pattern,
              {
                origin: s3Origin,
                cachePolicy: staticAssetsCachePolicy,
                viewerProtocolPolicy:
                  cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              },
            ],
          ),
        ),
        domainNames: [siteDomainName],
        certificate: siteCertificate,
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(0),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(0),
          },
        ],
        comment: `${stackName} - Bio Site`,
      },
    );

    new route53.ARecord(this, "SiteDnsRecord", {
      zone: hostedZone,
      recordName: siteDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(siteDistribution),
      ),
    });

    // Deploy dist/ to S3
    const distPath = path.join(__dirname, "../../../dist");
    new s3deploy.BucketDeployment(this, "DeployStaticSite", {
      sources: [s3deploy.Source.asset(distPath)],
      destinationBucket: siteBucket,
      distribution: siteDistribution,
      distributionPaths: ["/*"],
      memoryLimit: 2096,
      cacheControl: [
        s3deploy.CacheControl.fromString("public, max-age=0, must-revalidate"),
      ],
    });

    // =========================================================================
    // OUTPUTS
    // =========================================================================

    new CfnOutput(this, "ApiUrl", {
      value: `https://${apiDomainName}`,
      description: "Bio API URL (custom domain)",
    });

    new CfnOutput(this, "SiteUrl", {
      value: `https://${siteDomainName}`,
      description: "Bio site URL (custom domain)",
    });

    new CfnOutput(this, "ApiCloudFrontDomain", {
      value: apiDistribution.distributionDomainName,
      description: "API CloudFront distribution domain",
    });

    new CfnOutput(this, "SiteCloudFrontDomain", {
      value: siteDistribution.distributionDomainName,
      description: "Site CloudFront distribution domain",
    });

    new CfnOutput(this, "SiteBucketName", {
      value: siteBucket.bucketName,
      description: "Static site S3 bucket name",
    });

    new CfnOutput(this, "HttpApiEndpoint", {
      value: httpApi.url ?? "",
      description: "Raw HTTP API Gateway endpoint",
    });
  }
}
