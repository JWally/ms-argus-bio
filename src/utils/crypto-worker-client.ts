// Promise-based wrapper for the crypto Web Worker.
// Falls back to direct crypto.ts calls if the Worker fails to load.

import { generateKeys, encryptPayload, decryptChallengeResponse, type CryptoKeys } from './crypto';

let worker: Worker | null = null;
let port: MessagePort | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Fallback state: when Worker can't load, use main-thread crypto
let fallbackKeys: CryptoKeys | null = null;
let usingWorker = false;

function postAndWait<T>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    const msgWithId = { ...msg, id };
    // Route through MessageChannel port if available, else direct Worker
    if (transfer?.length) {
      (port ?? worker!).postMessage(msgWithId, transfer);
    } else {
      (port ?? worker!).postMessage(msgWithId);
    }
  });
}

function handleMessage(e: MessageEvent) {
  const { id, error, ...rest } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) {
    p.reject(new Error(error));
  } else {
    p.resolve(rest);
  }
}

/** Initialize crypto — spawns Worker if possible, falls back to main-thread.
 *  Returns the raw public key string. */
export async function initCrypto(): Promise<{ rawPublicKey: string; usingWorker: boolean }> {
  // Try Worker first
  try {
    worker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onerror = () => {
      // Worker failed — fall through to fallback on next call
      worker = null;
      port = null;
      usingWorker = false;
    };

    // Set up MessageChannel — bot's Worker Proxy only sees the opaque port transfer,
    // never actual challenge data on the worker.postMessage channel.
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = handleMessage;
    worker.postMessage({ type: 'init-port', port: channel.port2 }, [channel.port2]);

    const result = await postAndWait<{ rawPublicKey: string }>({ type: 'init' });
    usingWorker = true;
    return { rawPublicKey: result.rawPublicKey, usingWorker: true };
  } catch {
    // Worker failed to load — fall back to main thread
    worker = null;
    port = null;
    usingWorker = false;
    fallbackKeys = await generateKeys();
    return { rawPublicKey: fallbackKeys.rawPublicKey, usingWorker: false };
  }
}

/** Decrypted challenge — new format (8-bit images) or old format (1-bit masks) */
export type DecryptedChallenge =
  | { images: string[]; width: number; height: number }
  | { masks: string[]; types: string[]; maskWidth: number; maskHeight: number };

/** Decrypt challenge response from server. */
export async function workerDecrypt(
  encryptedB64: string,
  serverPubKeyB64: string
): Promise<DecryptedChallenge> {
  if (usingWorker && worker) {
    const result = await postAndWait<{ data: DecryptedChallenge }>({
      type: 'decrypt',
      encryptedB64,
      serverPubKeyB64,
    });
    return result.data;
  }

  // Fallback: main-thread decryption
  if (!fallbackKeys) throw new Error('Crypto not initialized');
  return decryptChallengeResponse(
    encryptedB64,
    fallbackKeys.privateKey,
    serverPubKeyB64
  ) as Promise<DecryptedChallenge>;
}

/** Encrypt payload for server. Returns Uint8Array. */
export async function workerEncrypt(payload: object, serverPubKeyB64: string): Promise<Uint8Array> {
  if (usingWorker && worker) {
    const result = await postAndWait<{ encrypted: Uint8Array }>({
      type: 'encrypt',
      payload,
      serverPubKeyB64,
    });
    return result.encrypted;
  }

  // Fallback: main-thread encryption
  if (!fallbackKeys) throw new Error('Crypto not initialized');
  return encryptPayload(payload, fallbackKeys.privateKey, serverPubKeyB64);
}

/** Get the raw public key for the current session (Worker or fallback). */
export function getRawPublicKey(): string | null {
  // The caller should have stored this from initCrypto result
  return null;
}

// ── Worker animation API (OffscreenCanvas path) ──────────────────────────────

/**
 * Transfer canvas control to the crypto worker and start the dot animation.
 * The OffscreenCanvas is Transferred — the main thread loses access after this call.
 * Only call this once per canvas element.
 */
export async function workerAnimate(
  index: number,
  canvas: OffscreenCanvas,
  canvasWidth: number,
  frameStep: number
): Promise<void> {
  if (!usingWorker || !worker) return;
  await postAndWait({ type: 'animate', index, canvas, canvasWidth, frameStep }, [canvas]);
}

/**
 * Switch to a different glyph index. The worker rebuilds dot layout and restarts the loop.
 * Canvas must already be in the worker (call workerAnimate first).
 */
export async function workerSwitchGlyph(index: number): Promise<void> {
  if (!usingWorker || !worker) return;
  await postAndWait({ type: 'switch-glyph', index });
}

/** Stop the animation loop in the worker. */
export async function workerStopAnimate(): Promise<void> {
  if (!usingWorker || !worker) return;
  await postAndWait({ type: 'stop-animate' });
}

/**
 * Restart animation without re-transferring the canvas.
 * Used after React StrictMode cleanup+remount when the canvas DOM node is reused.
 */
export async function workerRestartAnimate(index: number, frameStep: number): Promise<void> {
  if (!usingWorker || !worker) return;
  await postAndWait({ type: 'restart-animate', index, frameStep });
}
