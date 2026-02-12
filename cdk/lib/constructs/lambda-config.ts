// cdk/lib/constructs/lambda-config.ts
// Lambda bundling configuration for Qdrant-compatible functions

import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * Creates Lambda configuration for functions that use the Qdrant client.
 * Uses CommonJS format to avoid ESM compatibility issues with the Qdrant client.
 */
export function createVectorLambdaConfig(): Partial<lambdaNode.NodejsFunctionProps> {
  const bundling: lambdaNode.BundlingOptions = {
    minify: true,
    sourceMap: true,
    target: 'node20',
    format: lambdaNode.OutputFormat.CJS,
    mainFields: ['main', 'module'],
    keepNames: true,
  };

  return {
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.ARM_64,
    bundling,
    tracing: lambda.Tracing.ACTIVE,
  };
}

/**
 * Creates base environment variables for Powertools integration.
 */
export function createPowertoolsEnv(
  serviceName: string,
  metricsNamespace: string
): Record<string, string> {
  return {
    POWERTOOLS_SERVICE_NAME: serviceName,
    POWERTOOLS_METRICS_NAMESPACE: metricsNamespace,
    NODE_OPTIONS: '--enable-source-maps',
  };
}
