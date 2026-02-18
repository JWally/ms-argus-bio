#!/usr/bin/env tsx
// scripts/generate-ecdh-key.ts
// Bootstrap script — generates initial ECDH key pair and writes to SSM.
// Run once after first deploy: npx tsx scripts/generate-ecdh-key.ts

import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

const STACK_NAME = process.env.STACK_NAME || 'ms-argus-bio-dev-jw';
const PARAM_NAME = `/${STACK_NAME}/ecdh-keypair`;

async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ]);

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);

  return {
    privateKey: Buffer.from(pkcs8).toString('base64'),
    publicKey: Buffer.from(spki).toString('base64'),
    rawPublicKey: Buffer.from(raw).toString('base64'),
    createdAt: Date.now(),
  };
}

async function main() {
  const ssm = new SSMClient({ region: 'us-east-1' });

  // Check if param already exists
  try {
    const existing = await ssm.send(
      new GetParameterCommand({ Name: PARAM_NAME, WithDecryption: true })
    );
    const parsed = JSON.parse(existing.Parameter?.Value || '{}');
    if (parsed.current) {
      console.log(
        `Parameter ${PARAM_NAME} already has keys (created ${new Date(parsed.current.createdAt).toISOString()})`
      );
      console.log('Use --force to overwrite');
      if (!process.argv.includes('--force')) return;
    }
  } catch {
    // Param doesn't exist — create it
  }

  const keys = await generateKeyPair();
  const value = JSON.stringify({ current: keys, previous: null });

  await ssm.send(
    new PutParameterCommand({
      Name: PARAM_NAME,
      Value: value,
      Type: 'SecureString',
      Overwrite: true,
    })
  );

  console.log(`ECDH key pair written to SSM: ${PARAM_NAME}`);
  console.log(`  Public key (raw): ${keys.rawPublicKey.slice(0, 20)}...`);
  console.log(`  Created: ${new Date(keys.createdAt).toISOString()}`);
}

main().catch((err) => {
  console.error('Failed to generate ECDH key:', err);
  process.exit(1);
});
