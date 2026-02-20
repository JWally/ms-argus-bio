// src/utils/crypto.ts
// Client-side ECDH encryption for biometric payloads using direct Web Crypto API.
// Flow: JSON → deflateRaw → ECDH+HKDF(date) AES-256-GCM encrypt → [iv(12) | ciphertext+tag]

import { deflateRaw } from 'pako';
import { sboxReverse } from './sbox';

/** Length of a base64-encoded raw P-256 public key (65 bytes → 88 chars) */
const SERVER_KEY_LEN = 88;

const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

export interface CryptoKeys {
  privateKey: CryptoKey;
  rawPublicKey: string;
}

/** Generate ephemeral ECDH key pair for this session */
export async function generateKeys(): Promise<CryptoKeys> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // non-extractable private key
    ['deriveBits']
  );

  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const rawPublicKey = uint8ToBase64(new Uint8Array(rawPub));

  return { privateKey: keyPair.privateKey, rawPublicKey };
}

/** Extract server's raw public key appended to the challengeId.
 *  Server appends 88-char base64 raw public key to the end. */
export function extractServerKey(challengeId: string): {
  challengeId: string;
  serverPubKey: string;
} {
  if (challengeId.length <= SERVER_KEY_LEN) {
    return { challengeId, serverPubKey: '' };
  }
  return {
    challengeId: challengeId.slice(0, -SERVER_KEY_LEN),
    serverPubKey: challengeId.slice(-SERVER_KEY_LEN),
  };
}

/** Encrypt payload: JSON → deflateRaw → ECDH+HKDF(date) AES-GCM → [iv | ciphertext+tag].
 *  Returns a Uint8Array ready to send as the fetch body. */
export async function encryptPayload(
  payload: object,
  clientPrivateKey: CryptoKey,
  serverPublicKeyB64: string
): Promise<Uint8Array> {
  // 1. JSON → raw deflate
  const json = JSON.stringify(payload);
  const compressed = deflateRaw(new TextEncoder().encode(json));

  // 2. Import server's raw public key
  const serverPubBytes = base64ToUint8(serverPublicKeyB64);
  const serverPubKey = await crypto.subtle.importKey(
    'raw',
    serverPubBytes.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. Derive AES-256-GCM key via ECDH + HKDF (date salt)
  const aesKey = await deriveAesKey(clientPrivateKey, serverPubKey);

  // 4. Encrypt with AES-256-GCM (random 12-byte IV)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    compressed.buffer as ArrayBuffer
  );

  // 5. Pack: [iv (12 bytes) | ciphertext + auth tag]
  const ctBytes = new Uint8Array(ciphertext);
  const packed = new Uint8Array(12 + ctBytes.length);
  packed.set(iv);
  packed.set(ctBytes, 12);
  return packed;
}

/** Derive an AES-256-GCM key from ECDH shared secret + HKDF with today's UTC date as salt */
async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  usages: KeyUsage[] = ['encrypt']
): Promise<CryptoKey> {
  // ECDH → 256-bit shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );

  // Import as HKDF key material
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  // HKDF → AES-256-GCM key (salt = today's UTC date, info = "argus-bio-v1")
  const salt = new TextEncoder().encode(new Date().toISOString().slice(0, 10));
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** Decrypt a challenge response encrypted by the server with ECDH shared secret.
 *  Input: base64 string of [iv(12) | ciphertext+tag]. */
export async function decryptChallengeResponse(
  encryptedB64: string,
  clientPrivateKey: CryptoKey,
  serverPublicKeyB64: string
): Promise<Record<string, unknown>> {
  const packed = base64ToUint8(encryptedB64);
  // .slice() creates fresh ArrayBuffer copies (avoids TS ArrayBufferLike issues with subarray)
  const iv = packed.slice(0, 12);
  const ciphertextWithTag = packed.slice(12);

  const serverPubBytes = base64ToUint8(serverPublicKeyB64);
  const serverPubKey = await crypto.subtle.importKey(
    'raw',
    serverPubBytes.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const aesKey = await deriveAesKey(clientPrivateKey, serverPubKey, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertextWithTag);

  // Reverse the S-box obfuscation layer applied by the server before AES encryption
  const reversed = sboxReverse(new Uint8Array(decrypted));
  return JSON.parse(new TextDecoder().decode(reversed));
}

/** Convert Uint8Array → base64 (chunked to avoid stack overflow) */
function uint8ToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

/** Convert base64 → Uint8Array */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
