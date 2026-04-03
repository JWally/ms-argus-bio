// server/ecdh.ts
// ECDH key exchange + AES-256-GCM encryption/decryption for biometric API.
// Server→client: JSON → sboxApply → AES-GCM → base64
// Client→server: deflateRaw(JSON) → AES-GCM → [iv|ciphertext+tag]

import { randomBytes } from 'crypto';
import { inflateRawSync } from 'zlib';
import { sboxApply } from './sbox';
import type { BiometricPayload } from './types';

export interface EcdhKeyData {
  privateKey: string;
  publicKey: string;
  rawPublicKey: string;
  createdAt: number;
}

export interface EcdhKeys {
  current: EcdhKeyData;
  previous?: EcdhKeyData;
}

const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

/** Derive an AES-256-GCM key from ECDH shared secret + HKDF with a date salt.
 *  `privKeyPkcs8`: PKCS8 base64 private key (either party's).
 *  `peerPubKeyRaw`: raw base64 public key of the other party (65 bytes with 04 prefix). */
export async function deriveAesKeyServer(
  privKeyPkcs8: string,
  peerPubKeyRaw: string,
  dateSalt: string,
  usages: ('encrypt' | 'decrypt')[] = ['decrypt']
) {
  const privBytes = Buffer.from(privKeyPkcs8, 'base64');
  const privKey = await crypto.subtle.importKey(
    'pkcs8',
    privBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );

  const pubBytes = Buffer.from(peerPubKeyRaw, 'base64');
  const peerPubKey = await crypto.subtle.importKey(
    'raw',
    pubBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPubKey },
    privKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const salt = new TextEncoder().encode(dateSalt);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** Encrypt an object for the client using ECDH shared secret.
 *  Applies S-box obfuscation before AES-256-GCM encryption.
 *  Returns base64 string of [iv(12) | ciphertext+tag]. */
export async function encryptForClient(
  data: object,
  serverPrivKey: string,
  clientPubKey: string
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const aesKey = await deriveAesKeyServer(serverPrivKey, clientPubKey, today, ['encrypt']);

  const plaintext = sboxApply(new TextEncoder().encode(JSON.stringify(data)));
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);

  const ct = Buffer.from(ciphertext);
  return Buffer.concat([iv, ct]).toString('base64');
}

/** Decrypt an encrypted biometric payload (octet-stream body).
 *  Tries current key first, falls back to previous for in-flight key rotation.
 *  For each key, tries today's date salt then yesterday's (midnight edge case).
 *  Client payload format: deflateRaw(JSON) → AES-GCM → [iv(12)|ciphertext+tag] */
export async function decryptPayload(
  body: string,
  isBase64Encoded: boolean,
  clientPubKey: string,
  ecdhKeys: EcdhKeys
): Promise<BiometricPayload | null> {
  const packed = isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf-8');
  const iv = packed.subarray(0, 12);
  const ciphertextWithTag = packed.subarray(12);

  const keySets = [ecdhKeys.current, ecdhKeys.previous].filter((k): k is EcdhKeyData => k != null);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = [today, yesterday];

  for (const keySet of keySets) {
    for (const dateSalt of dates) {
      try {
        const aesKey = await deriveAesKeyServer(keySet.privateKey, clientPubKey, dateSalt);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          aesKey,
          ciphertextWithTag
        );
        const inflated = inflateRawSync(Buffer.from(decrypted));
        return JSON.parse(inflated.toString('utf-8')) as BiometricPayload;
      } catch {
        continue;
      }
    }
  }

  return null;
}
