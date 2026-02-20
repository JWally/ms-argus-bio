// Web Worker for ECDH crypto operations.
// The private key stays inside this Worker's isolated global scope.
// Main thread addInitScript patches cannot reach crypto.subtle here.

import { deflateRaw } from 'pako';
import { sboxReverse } from '../utils/sbox';

const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

// Module-scope private key — never leaves the Worker
let privateKey: CryptoKey | null = null;

/** Derive AES-256-GCM key from ECDH shared secret + HKDF (date salt) */
async function deriveAesKey(
  privKey: CryptoKey,
  publicKey: CryptoKey,
  usages: KeyUsage[] = ['decrypt']
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const salt = new TextEncoder().encode(new Date().toISOString().slice(0, 10));
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** Import a raw public key (base64) as CryptoKey */
async function importRawPubKey(b64: string): Promise<CryptoKey> {
  const bytes = base64ToUint8(b64);
  return crypto.subtle.importKey(
    'raw',
    bytes.buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface WorkerMessage {
  id: number;
  type: 'init' | 'decrypt' | 'encrypt';
  encryptedB64?: string;
  serverPubKeyB64?: string;
  payload?: object;
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'init': {
        const keyPair = await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveBits']
        );
        privateKey = keyPair.privateKey;

        const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        const rawPublicKey = uint8ToBase64(new Uint8Array(rawPub));
        self.postMessage({ id, rawPublicKey });
        break;
      }

      case 'decrypt': {
        if (!privateKey) throw new Error('Worker not initialized');
        const { encryptedB64, serverPubKeyB64 } = e.data;
        if (!encryptedB64 || !serverPubKeyB64) throw new Error('Missing decrypt params');

        const packed = base64ToUint8(encryptedB64);
        const iv = packed.slice(0, 12);
        const ciphertextWithTag = packed.slice(12);

        const serverPubKey = await importRawPubKey(serverPubKeyB64);
        const aesKey = await deriveAesKey(privateKey, serverPubKey, ['decrypt']);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          aesKey,
          ciphertextWithTag
        );

        // Reverse S-box obfuscation applied by server before AES encryption
        const reversed = sboxReverse(new Uint8Array(decrypted));
        const data = JSON.parse(new TextDecoder().decode(reversed));
        self.postMessage({ id, data });
        break;
      }

      case 'encrypt': {
        if (!privateKey) throw new Error('Worker not initialized');
        const { payload, serverPubKeyB64 } = e.data;
        if (!payload || !serverPubKeyB64) throw new Error('Missing encrypt params');

        const json = JSON.stringify(payload);
        const compressed = deflateRaw(new TextEncoder().encode(json));

        const serverPubKey = await importRawPubKey(serverPubKeyB64);
        const aesKey = await deriveAesKey(privateKey, serverPubKey, ['encrypt']);

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          aesKey,
          compressed.buffer as ArrayBuffer
        );

        const ctBytes = new Uint8Array(ciphertext);
        const result = new Uint8Array(12 + ctBytes.length);
        result.set(iv);
        result.set(ctBytes, 12);

        // Transfer the buffer for zero-copy
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (self.postMessage as any)({ id, encrypted: result }, [result.buffer]);
        break;
      }
    }
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
