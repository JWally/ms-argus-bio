// cdk/lib/stacks/bio-stack.ts
// Main CDK stack for ms-argus-bio classification API

import * as path from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
import { createVectorLambdaConfig, createPowertoolsEnv } from "../constructs/lambda-config";

export interface BioStackProps extends StackProps {
  stage: string;
  vectorEnvironment: string;
}

export class BioStack extends Stack {
  constructor(scope: Construct, id: string, props: BioStackProps) {
    super(scope, id, props);

    const { stage, vectorEnvironment } = props;
    const stackName = this.stackName;

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

    // =========================================================================
    // OUTPUTS
    // =========================================================================

    new CfnOutput(this, "ApiUrl", {
      value: httpApi.url ?? "",
      description: "Bio classification API URL",
    });
  }
}
