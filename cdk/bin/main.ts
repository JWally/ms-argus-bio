#!/usr/bin/env node
// cdk/bin/main.ts
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { BioStack } from '../lib/stacks/bio-stack';
import { AWS_ACCOUNT_ID, PIPELINE_HOME_REGION, ROOT_DOMAIN } from './config';

const app = new App();

const synthesizer = new CliCredentialsStackSynthesizer();

// /////////////////////////////////
// Development stack (jw)
// Run: cdk deploy ms-argus-bio-dev-jw
// /////////////////////////////////
new BioStack(app, 'ms-argus-bio-dev-jw', {
  env: { account: AWS_ACCOUNT_ID, region: PIPELINE_HOME_REGION },
  stackName: 'ms-argus-bio-dev-jw',
  stage: 'dev',
  environment: 'dev-jw',
  vectorEnvironment: 'dev-jw',
  rootDomain: ROOT_DOMAIN,
  synthesizer,
});

app.synth();
