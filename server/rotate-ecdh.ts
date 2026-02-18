// server/rotate-ecdh.ts
// Lambda handler for ECDH key rotation — scheduled via EventBridge every 14 days.
// Uses raw Web Crypto API (no ez-web-crypto) to keep bundle small.

import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

interface KeyData {
  privateKey: string;
  publicKey: string;
  rawPublicKey: string;
  createdAt: number;
}

async function generateKeyPair(): Promise<KeyData> {
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

export async function handler(): Promise<{ statusCode: number; body: string }> {
  const paramName = process.env.ECDH_KEY_PARAM;
  if (!paramName) throw new Error('ECDH_KEY_PARAM env var not set');

  // Read current value
  let current: KeyData | null = null;
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true })
    );
    const parsed = JSON.parse(result.Parameter?.Value || '{}');
    current = parsed.current ?? null;
  } catch {
    // First run or param doesn't exist yet
  }

  // Generate new key pair
  const newKeys = await generateKeyPair();

  // Rotate: new → current, old current → previous
  const value = JSON.stringify({
    current: newKeys,
    previous: current,
  });

  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: value,
      Type: 'SecureString',
      Overwrite: true,
    })
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      rotated: true,
      createdAt: newKeys.createdAt,
      hasPrevious: current !== null,
    }),
  };
}
