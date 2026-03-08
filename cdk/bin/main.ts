#!/usr/bin/env node
// cdk/bin/main.ts
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { BioStack } from '../lib/stacks/bio-stack';
import { CheckoutStack } from '../lib/stacks/checkout-stack';
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

// /////////////////////////////////
// Checkout demo (wolcott.io)
// Run: cdk deploy argus-checkout-demo -c bioApiSecret=ak_live_...
// /////////////////////////////////
const bioApiSecret = app.node.tryGetContext('bioApiSecret') as string | undefined;
if (bioApiSecret) {
  new CheckoutStack(app, 'argus-checkout-demo', {
    env: { account: AWS_ACCOUNT_ID, region: PIPELINE_HOME_REGION },
    stackName: 'argus-checkout-demo',
    bioApiUrl: 'https://api-bio-dev-jw.argus.pw',
    bioApiSecret,
    domainName: 'checkout.wolcott.io',
    hostedZoneDomain: 'wolcott.io',
    hostedZoneId: 'Z26NIK6FG5FP6',
    synthesizer,
  });
}

app.synth();
