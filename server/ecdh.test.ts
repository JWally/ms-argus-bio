// server/ecdh.test.ts
// Real ECDH roundtrip tests — no mocking of crypto primitives.
// Uses actual Web Crypto key generation, ECDH derivation, and AES-256-GCM.

import { deflateRawSync } from 'zlib';
import { randomBytes } from 'crypto';
import { describe, it, expect } from 'vitest';
import { deriveAesKeyServer, encryptForClient, decryptPayload } from './ecdh';
import { sboxReverse } from './sbox';
import type { EcdhKeys } from './ecdh';

// ── Key generation helpers ───────────────────────────────────────────

/** Generate a P-256 keypair and export as { privPkcs8, rawPub } (both base64) */
async function generateTestKeyPair(): Promise<{ privPkcs8: string; rawPub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const privPkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString(
    'base64'
  );
  const rawPub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
  return { privPkcs8, rawPub };
}

/** Simulate client-side payload encryption:
 *  deflateRaw(JSON) → ECDH AES-GCM → [iv(12)|ciphertext+tag]
 *  Returns base64-encoded packed buffer (matching isBase64Encoded=true). */
async function simulateClientEncrypt(
  payload: object,
  clientPrivPkcs8: string,
  serverRawPub: string,
  dateSalt: string
): Promise<string> {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload)));
  // ECDH is symmetric: client derives key using (client_priv, server_pub)
  // deriveAesKeyServer accepts any (priv, peerPub) pair
  const aesKey = await deriveAesKeyServer(clientPrivPkcs8, serverRawPub, dateSalt, ['encrypt']);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    compressed.buffer as ArrayBuffer
  );
  return Buffer.concat([iv, Buffer.from(ciphertext)]).toString('base64');
}

// ── Tests ────────────────────────────────────────────────────────────

const SAMPLE_PAYLOAD = {
  challengeId: 'test-abc',
  challenge: [1, 2, 3],
  timestamp: 1700000000000,
  completionTimeMs: 3500,
  passed: true,
  digits: [],
  confidenceTimeline: [],
  inputType: 'mouse',
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 2,
  userAgent: 'Mozilla/5.0',
  features: { strokeCount: 5, totalPoints: 100 },
};

describe('deriveAesKeyServer', () => {
  it('produces the same key from either side of the ECDH exchange', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const date = '2025-01-01';

    // Server derives key using (server_priv, client_pub)
    const keyFromServer = await deriveAesKeyServer(server.privPkcs8, client.rawPub, date, [
      'encrypt',
    ]);

    // Encrypt same plaintext with both keys — ciphertext won't match (different IVs)
    // but decrypting each other's output proves they're the same key
    const iv = randomBytes(12);
    const plaintext = new TextEncoder().encode('hello');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyFromServer, plaintext);

    const decryptKey = await deriveAesKeyServer(client.privPkcs8, server.rawPub, date, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptKey, ct);
    expect(new TextDecoder().decode(decrypted)).toBe('hello');
  });

  it('produces different keys for different date salts', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();

    const key1 = await deriveAesKeyServer(server.privPkcs8, client.rawPub, '2025-01-01', [
      'encrypt',
    ]);

    // Encrypting with key1, then trying to decrypt with key2 (different date) should fail
    const iv = randomBytes(12);
    const plaintext = new TextEncoder().encode('test');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, plaintext);

    const decryptKey2 = await deriveAesKeyServer(server.privPkcs8, client.rawPub, '2025-01-02', [
      'decrypt',
    ]);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptKey2, ct)).rejects.toThrow();
  });
});

describe('decryptPayload (client→server path)', () => {
  it('decrypts a correctly-encrypted payload', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const today = new Date().toISOString().slice(0, 10);

    const encrypted = await simulateClientEncrypt(
      SAMPLE_PAYLOAD,
      client.privPkcs8,
      server.rawPub,
      today
    );

    const ecdhKeys: EcdhKeys = {
      current: {
        privateKey: server.privPkcs8,
        publicKey: server.rawPub,
        rawPublicKey: server.rawPub,
        createdAt: Date.now(),
      },
    };

    const result = await decryptPayload(encrypted, true, client.rawPub, ecdhKeys);
    expect(result).not.toBeNull();
    expect(result?.challengeId).toBe('test-abc');
    expect(result?.completionTimeMs).toBe(3500);
    expect(result?.passed).toBe(true);
  });

  it('returns null for tampered ciphertext', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const today = new Date().toISOString().slice(0, 10);

    const encrypted = await simulateClientEncrypt(
      SAMPLE_PAYLOAD,
      client.privPkcs8,
      server.rawPub,
      today
    );

    // Flip a byte in the ciphertext
    const buf = Buffer.from(encrypted, 'base64');
    buf[20] ^= 0xff;
    const tampered = buf.toString('base64');

    const ecdhKeys: EcdhKeys = {
      current: {
        privateKey: server.privPkcs8,
        publicKey: server.rawPub,
        rawPublicKey: server.rawPub,
        createdAt: Date.now(),
      },
    };

    const result = await decryptPayload(tampered, true, client.rawPub, ecdhKeys);
    expect(result).toBeNull();
  });

  it('falls back to previous key after rotation', async () => {
    const oldServer = await generateTestKeyPair();
    const newServer = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const today = new Date().toISOString().slice(0, 10);

    // Payload encrypted with old server key (in-flight during rotation)
    const encrypted = await simulateClientEncrypt(
      SAMPLE_PAYLOAD,
      client.privPkcs8,
      oldServer.rawPub,
      today
    );

    const ecdhKeys: EcdhKeys = {
      current: {
        privateKey: newServer.privPkcs8,
        publicKey: newServer.rawPub,
        rawPublicKey: newServer.rawPub,
        createdAt: Date.now(),
      },
      previous: {
        privateKey: oldServer.privPkcs8,
        publicKey: oldServer.rawPub,
        rawPublicKey: oldServer.rawPub,
        createdAt: Date.now() - 86_400_000,
      },
    };

    const result = await decryptPayload(encrypted, true, client.rawPub, ecdhKeys);
    expect(result).not.toBeNull();
    expect(result?.challengeId).toBe('test-abc');
  });

  it('returns null when wrong client key is used', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const impostor = await generateTestKeyPair();
    const today = new Date().toISOString().slice(0, 10);

    const encrypted = await simulateClientEncrypt(
      SAMPLE_PAYLOAD,
      client.privPkcs8,
      server.rawPub,
      today
    );

    const ecdhKeys: EcdhKeys = {
      current: {
        privateKey: server.privPkcs8,
        publicKey: server.rawPub,
        rawPublicKey: server.rawPub,
        createdAt: Date.now(),
      },
    };

    // Pass impostor's public key instead of client's
    const result = await decryptPayload(encrypted, true, impostor.rawPub, ecdhKeys);
    expect(result).toBeNull();
  });
});

describe('encryptForClient (server→client path)', () => {
  it('produces ciphertext decryptable by the client', async () => {
    const server = await generateTestKeyPair();
    const client = await generateTestKeyPair();
    const data = { images: ['abc', 'def'], width: 28, height: 28 };

    const encrypted = await encryptForClient(data, server.privPkcs8, client.rawPub);

    // Simulate client decryption: (client_priv, server_pub) → AES key → decrypt → sboxReverse
    const today = new Date().toISOString().slice(0, 10);
    const aesKey = await deriveAesKeyServer(client.privPkcs8, server.rawPub, today, ['decrypt']);

    const packed = Buffer.from(encrypted, 'base64');
    const iv = packed.subarray(0, 12);
    const ct = packed.subarray(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    const reversed = sboxReverse(new Uint8Array(decrypted));
    const parsed = JSON.parse(new TextDecoder().decode(reversed));

    expect(parsed).toEqual(data);
  });
});
