// cdk/lib/stacks/bio-stack.ts
// Main CDK stack for ms-argus-bio classification API

import * as path from 'path';
import { fileURLToPath } from 'url';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { createVectorLambdaConfig, createPowertoolsEnv } from '../constructs/lambda-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BioStackProps extends StackProps {
  stage: string;
  environment: string;
  vectorEnvironment: string;
  rootDomain: string;
}

const INDEX_HTML = 'index.html';
const INDEX_HTML_PATH = '/index.html';

export class BioStack extends Stack {
  constructor(scope: Construct, id: string, props: BioStackProps) {
    super(scope, id, props);

    const { stage, environment, vectorEnvironment, rootDomain } = props;
    const stackName = this.stackName;

    // Compute domain names
    const apiSubdomain = stage === 'prod' ? 'api-bio' : `api-bio-${environment}`;
    const siteSubdomain = stage === 'prod' ? 'bio' : `bio-${environment}`;
    const apiDomainName = `${apiSubdomain}.${rootDomain}`;
    const siteDomainName = `${siteSubdomain}.${rootDomain}`;

    // =========================================================================
    // CROSS-STACK IMPORTS (via SSM Parameter Store)
    // =========================================================================

    // VPC from ms-argus-infra
    const vpcId = ssm.StringParameter.valueFromLookup(this, `/argus/${vectorEnvironment}/vpc-id`);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });

    // Qdrant connection from ms-argus-vector
    const vectorSsmPrefix = `/argus-vector/${vectorEnvironment}`;
    const qdrantUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `${vectorSsmPrefix}/qdrant-url`
    );
    const qdrantSecretArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${vectorSsmPrefix}/qdrant-secret-arn`
    );

    // Sigint probe tokens table from ms-argus-platform
    // Written by ms-argus-sigint; redeemed here to score JA4/H2/TCP fingerprints.
    const sigintSsmPrefix = `/argus-platform/${environment}`;
    const probeTokensTableName = ssm.StringParameter.valueForStringParameter(
      this,
      `${sigintSsmPrefix}/probe-tokens-table-name`
    );
    const probeTokensTableArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${sigintSsmPrefix}/probe-tokens-table-arn`
    );

    // =========================================================================
    // DNS & CERTIFICATES
    // =========================================================================

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: rootDomain,
    });

    const apiCertificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: apiDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const siteCertificate = new acm.Certificate(this, 'SiteCertificate', {
      domainName: siteDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // =========================================================================
    // LAMBDA SECURITY GROUP
    // =========================================================================

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      securityGroupName: `${stackName}-lambda-sg`,
      description: 'Security group for bio classify Lambda',
      allowAllOutbound: true,
    });

    // =========================================================================
    // CLOUDWATCH LOG GROUP
    // =========================================================================

    const logGroup = new logs.LogGroup(this, 'ClassifyLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-classify`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // DYNAMODB TABLES
    // =========================================================================

    const merchantsTable = new dynamodb.Table(this, 'MerchantsTable', {
      tableName: `${stackName}-merchants`,
      partitionKey: { name: 'merchantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    merchantsTable.addGlobalSecondaryIndex({
      indexName: 'apiKeyHash-index',
      partitionKey: { name: 'apiKeyHash', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `${stackName}-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const tokensTable = new dynamodb.Table(this, 'TokensTable', {
      tableName: `${stackName}-tokens`,
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // =========================================================================
    // ECDH KEY MANAGEMENT (SSM + Rotation Lambda + EventBridge)
    // =========================================================================

    const ecdhKeyParam = new ssm.StringParameter(this, 'EcdhKeyParam', {
      parameterName: `/${stackName}/ecdh-keypair`,
      stringValue: '{}', // empty initial value — run scripts/generate-ecdh-key.ts to bootstrap
      description: 'ECDH key pair for payload encryption (current + previous)',
      tier: ssm.ParameterTier.STANDARD,
    });

    const rotationLogGroup = new logs.LogGroup(this, 'RotationLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-rotate-ecdh`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const rotationFn = new lambda.NodejsFunction(this, 'RotateEcdhHandler', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../../server/rotate-ecdh.ts'),
      handler: 'handler',
      functionName: `${stackName}-rotate-ecdh`,
      memorySize: 128,
      timeout: Duration.seconds(15),
      logGroup: rotationLogGroup,
      bundling: {
        minify: true,
        target: 'node20',
        format: lambda.OutputFormat.CJS,
      },
      environment: {
        ECDH_KEY_PARAM: ecdhKeyParam.parameterName,
      },
    });

    // Rotation Lambda needs read+write to the SSM param
    ecdhKeyParam.grantRead(rotationFn);
    ecdhKeyParam.grantWrite(rotationFn);

    // Schedule rotation every 14 days
    new events.Rule(this, 'EcdhRotationSchedule', {
      ruleName: `${stackName}-ecdh-rotation`,
      schedule: events.Schedule.rate(Duration.days(14)),
      targets: [new targets.LambdaFunction(rotationFn)],
    });

    // =========================================================================
    // LAMBDA FUNCTION
    // =========================================================================

    const serverModelDir = path.join(__dirname, '../../../server/model');
    const vectorConfig = createVectorLambdaConfig();

    const classifyFn = new lambda.NodejsFunction(this, 'ClassifyHandler', {
      ...vectorConfig,
      bundling: {
        ...vectorConfig.bundling,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            `mkdir -p ${outputDir}/model`,
            `cp ${serverModelDir}/weights.bin ${outputDir}/model/weights.bin`,
            `test -f ${serverModelDir}/config.json && cp ${serverModelDir}/config.json ${outputDir}/model/config.json || true`,
          ],
        },
      },
      entry: path.join(__dirname, '../../../server/handler.ts'),
      handler: 'handler',
      functionName: `${stackName}-classify`,
      memorySize: 1024,
      timeout: Duration.seconds(30),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      logGroup,
      environment: {
        ...createPowertoolsEnv('bio-classify', stackName),
        QDRANT_URL: qdrantUrl,
        QDRANT_SECRET_ARN: qdrantSecretArn,
        STAGE: stage,
        MERCHANTS_TABLE: merchantsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        TOKENS_TABLE: tokensTable.tableName,
        SITE_DOMAIN: siteDomainName,
        ECDH_KEY_PARAM: ecdhKeyParam.parameterName,
        PROBE_TOKENS_TABLE: probeTokensTableName,
        PROBE_ENFORCE: 'false',
      },
    });

    // Grant SSM read access for ECDH keys
    ecdhKeyParam.grantRead(classifyFn);

    // Grant Secrets Manager access for Qdrant API key
    classifyFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['arn:aws:secretsmanager:*:*:secret:argus-vector/*'],
      })
    );

    // Grant DynamoDB access for CaaS tables
    merchantsTable.grantReadWriteData(classifyFn);
    sessionsTable.grantReadWriteData(classifyFn);
    tokensTable.grantReadWriteData(classifyFn);

    // Grant read-only access to sigint probe tokens table (GetItem only — never write)
    classifyFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [probeTokensTableArn],
      })
    );

    // =========================================================================
    // HTTP API GATEWAY
    // =========================================================================

    const httpApi = new apigatewayv2.HttpApi(this, 'BioApi', {
      apiName: `${stackName}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'X-Canvas-Fp'],
        maxAge: Duration.hours(1),
      },
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'ClassifyIntegration',
      classifyFn
    );

    httpApi.addRoutes({
      path: '/v1/challenge',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/session',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/classify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/verify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // Admin routes — IAM-authorized. Destructive (flush/relabel) and
    // data-exfil (scroll) endpoints must not be world-reachable. Callers
    // sign with SigV4; only principals granted execute-api:Invoke on this
    // API can reach them. See docs/admin-auth.md for invocation examples.
    const adminAuthorizer = new HttpIamAuthorizer();

    httpApi.addRoutes({
      path: '/admin/flush',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/scroll',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/relabel',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: adminAuthorizer,
    });

    // =========================================================================
    // LAMBDA WARMER
    // =========================================================================

    new events.Rule(this, 'ClassifyWarmerRule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(classifyFn)],
    });

    // =========================================================================
    // API CLOUDFRONT
    // =========================================================================

    // httpApi.url is a CDK token — extract domain with Fn.split (token-safe)
    const apiGatewayDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.url!));

    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'ApiOriginRequestPolicy',
      {
        originRequestPolicyName: `${stackName}-api-origin-request`,
        comment: 'Forward viewer headers (no Host) + TLS fingerprints to Lambda',
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          'Content-Type',
          'User-Agent',
          'Accept',
          'Origin',
          'Referer',
          'X-Canvas-Fp',
          'Access-Control-Request-Method',
          'Access-Control-Request-Headers',
          'CloudFront-Viewer-JA3-Fingerprint',
          'CloudFront-Viewer-JA4-Fingerprint'
        ),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      }
    );

    const apiDistribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiGatewayDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: apiOriginRequestPolicy,
      },
      domainNames: [apiDomainName],
      certificate: apiCertificate,
      comment: `${stackName} - Bio API`,
    });

    new route53.ARecord(this, 'ApiDnsRecord', {
      zone: hostedZone,
      recordName: apiDomainName,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(apiDistribution)),
    });

    // =========================================================================
    // STATIC SITE (S3 + CloudFront)
    // =========================================================================

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, 'SiteOAI');
    siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [siteBucket.arnForObjects('*')],
        principals: [
          new iam.CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      })
    );

    // Cache policies
    const sharedCachePolicyProps = {
      minTtl: Duration.seconds(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    };
    const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetsCachePolicy', {
      ...sharedCachePolicyProps,
      cachePolicyName: `${stackName}-static-assets-cache`,
      comment: 'Cache policy for static assets with compression',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
    });

    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      ...sharedCachePolicyProps,
      cachePolicyName: `${stackName}-html-no-cache`,
      comment: 'No cache policy for HTML files with compression',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(1),
    });

    const s3Origin = new origins.S3Origin(siteBucket, {
      originAccessIdentity: oai,
    });

    const siteDistribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: htmlCachePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      additionalBehaviors: Object.fromEntries(
        [
          '*.js',
          '*.css',
          '*.woff*',
          '*.png',
          '*.jpg',
          '*.svg',
          '*.wasm',
          'model/*',
          'model-emnist/*',
        ].map((pattern) => [
          pattern,
          {
            origin: s3Origin,
            cachePolicy: staticAssetsCachePolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          },
        ])
      ),
      domainNames: [siteDomainName],
      certificate: siteCertificate,
      defaultRootObject: INDEX_HTML,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: INDEX_HTML_PATH,
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: INDEX_HTML_PATH,
          ttl: Duration.seconds(0),
        },
      ],
      comment: `${stackName} - Bio Site`,
    });

    new route53.ARecord(this, 'SiteDnsRecord', {
      zone: hostedZone,
      recordName: siteDomainName,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(siteDistribution)),
    });

    // Deploy dist/ to S3 — two deployments with different cache headers
    const distPath = path.join(__dirname, '../../../dist');

    // Hashed assets (JS, CSS, fonts, images) — immutable, long-lived cache
    new s3deploy.BucketDeployment(this, 'DeployStaticSite', {
      sources: [s3deploy.Source.asset(distPath)],
      destinationBucket: siteBucket,
      distribution: siteDistribution,
      distributionPaths: ['/*'],
      memoryLimit: 2096,
      exclude: [INDEX_HTML],
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
    });

    // HTML — no cache (always revalidate to pick up new deploys)
    new s3deploy.BucketDeployment(this, 'DeployHtml', {
      sources: [s3deploy.Source.asset(distPath)],
      destinationBucket: siteBucket,
      distribution: siteDistribution,
      distributionPaths: [INDEX_HTML_PATH],
      memoryLimit: 512,
      exclude: ['*'],
      include: [INDEX_HTML],
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
    });

    // =========================================================================
    // OUTPUTS
    // =========================================================================

    new CfnOutput(this, 'ApiUrl', {
      value: `https://${apiDomainName}`,
      description: 'Bio API URL (custom domain)',
    });

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${siteDomainName}`,
      description: 'Bio site URL (custom domain)',
    });

    new CfnOutput(this, 'ApiCloudFrontDomain', {
      value: apiDistribution.distributionDomainName,
      description: 'API CloudFront distribution domain',
    });

    new CfnOutput(this, 'SiteCloudFrontDomain', {
      value: siteDistribution.distributionDomainName,
      description: 'Site CloudFront distribution domain',
    });

    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'Static site S3 bucket name',
    });

    new CfnOutput(this, 'HttpApiEndpoint', {
      value: httpApi.url ?? '',
      description: 'Raw HTTP API Gateway endpoint',
    });
  }
}
