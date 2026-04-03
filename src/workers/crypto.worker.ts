// Web Worker for ECDH crypto operations.
// The private key stays inside this Worker's isolated global scope.
// Main thread addInitScript patches cannot reach crypto.subtle here.
//
// Challenge images are also cached here after decryption and NEVER sent back
// to the main thread. Instead, the worker renders them directly to an
// OffscreenCanvas via the 'animate' message — pixel arrays are never observable
// by bot hooks on worker.postMessage / MessagePort.onmessage.

import { deflateRaw } from 'pako';
import { sboxReverse } from '../utils/sbox';

const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

// ── Private key — never leaves the Worker ───────────────────────────
let privateKey: CryptoKey | null = null;

// ── Cached challenge images — never sent back to main thread ─────────
let cachedImages: string[] | null = null;
let cachedWidth = 0;
let cachedHeight = 0;

// ── Animation state ─────────────────────────────────────────────────
let animCanvas: OffscreenCanvas | null = null;
let animCtx: OffscreenCanvasRenderingContext2D | null = null;
let animDots: AnimDot[] | null = null;
let animFrameIdx = 0;
let animFrameStep = 1;
let animIntervalId: ReturnType<typeof setInterval> | null = null;
let animCanvasWidth = 280;

// ── Animation constants ─────────────────────────────────────────────
const NUM_FRAMES = 20;
const NUM_VISIBLE = 4;
const DOT_R = 3;
const DOT_GAP = 6;
const JITTER_PX = 1.5;
const CANVAS_H = 180;

const LETTER_COLORS = ['#a5b4fc', '#c4b5fd', '#93c5fd', '#c084fc', '#e0e7ff'];
const BG_SPOTLIGHT = ['#1e1e38', '#222240', '#1a1a34', '#202042', '#1c1c36'];
const BG_MUTED = ['#161624', '#131320', '#151528', '#181830', '#121220'];

interface AnimDot {
  x: number;
  y: number;
  r: number;
  on: string;
  off: string;
  isLetter: boolean;
  isSnow: boolean;
  group: number;
}

function rndPick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildAnimDots(pixels: Uint8Array, iw: number, ih: number, cw: number): AnimDot[] {
  const dots: AnimDot[] = [];
  for (let y = DOT_R + 1; y < CANVAS_H - DOT_R; y += DOT_GAP) {
    for (let x = DOT_R + 1; x < cw - DOT_R; x += DOT_GAP) {
      const jx = x + (Math.random() - 0.5) * DOT_GAP * 0.55;
      const jy = y + (Math.random() - 0.5) * DOT_GAP * 0.55;
      const mx = Math.min(iw - 1, Math.max(0, Math.floor((jx / cw) * iw)));
      const my = Math.min(ih - 1, Math.max(0, Math.floor((jy / CANVAS_H) * ih)));
      const isLetter = pixels[my * iw + mx] > 128;
      const dRatio =
        Math.sqrt((jx - cw / 2) ** 2 + (jy - CANVAS_H / 2) ** 2) /
        Math.sqrt((cw / 2) ** 2 + (CANVAS_H / 2) ** 2);
      const bg = isLetter && dRatio < 0.7 ? rndPick(BG_SPOTLIGHT) : rndPick(BG_MUTED);
      const sz = Math.random();
      const r =
        sz < 0.25
          ? Math.max(0.8, 1 + Math.random() * 0.8)
          : sz < 0.45
            ? Math.max(0.8, 1.8 + Math.random() * 0.8)
            : Math.max(0.8, DOT_R + (Math.random() - 0.5) * 1.2);
      dots.push({
        x: jx,
        y: jy,
        r,
        on: isLetter ? rndPick(LETTER_COLORS) : bg,
        off: bg,
        isLetter,
        isSnow: false,
        group: Math.floor(Math.random() * NUM_FRAMES),
      });
    }
  }

  addSnowDots(dots, cw);
  return dots;
}

/** Scatter out-of-phase snow dots — denser away from letter to preserve legibility. */
function addSnowDots(dots: AnimDot[], cw: number): void {
  const SNOW_ON_COLORS = ['#6366f1', '#7c3aed', '#60a5fa', '#7c3aed', '#4f46e5'];
  const letterDots = dots.filter((d) => d.isLetter);
  const attempts = Math.floor(dots.length * 0.23);
  for (let i = 0; i < attempts; i++) {
    const sx = DOT_R + 1 + Math.random() * (cw - 2 * (DOT_R + 1));
    const sy = DOT_R + 1 + Math.random() * (CANVAS_H - 2 * (DOT_R + 1));

    let minDist = Infinity;
    let nearestGroup = Math.floor(Math.random() * NUM_FRAMES);
    for (const ld of letterDots) {
      const d = Math.sqrt((sx - ld.x) ** 2 + (sy - ld.y) ** 2);
      if (d < minDist) {
        minDist = d;
        nearestGroup = ld.group;
      }
    }

    if (Math.random() > Math.min(1, minDist / 25)) continue;

    const sz = Math.random();
    const r =
      sz < 0.25
        ? Math.max(0.8, 1 + Math.random() * 0.8)
        : sz < 0.45
          ? Math.max(0.8, 1.8 + Math.random() * 0.8)
          : Math.max(0.8, DOT_R + (Math.random() - 0.5) * 1.2);

    dots.push({
      x: sx,
      y: sy,
      r,
      on: rndPick(SNOW_ON_COLORS),
      off: rndPick(BG_SPOTLIGHT), // off-state stays slightly lit, reduces strobe contrast
      isLetter: false,
      isSnow: true,
      group: (nearestGroup + NUM_FRAMES / 2) % NUM_FRAMES,
    });
  }
}

function renderAnimFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  dots: AnimDot[],
  frameIdx: number,
  cw: number
): void {
  ctx.clearRect(0, 0, cw, CANVAS_H);
  const batches = new Map<string, number[]>();
  for (const dot of dots) {
    const jx = dot.x + (Math.random() - 0.5) * JITTER_PX;
    const jy = dot.y + (Math.random() - 0.5) * JITTER_PX;
    const gDist = (dot.group - frameIdx + NUM_FRAMES) % NUM_FRAMES;
    const color = (dot.isLetter || dot.isSnow) && gDist < NUM_VISIBLE ? dot.on : dot.off;
    if (!batches.has(color)) batches.set(color, []);
    const r = dot.r;
    batches.get(color)!.push(jx - r, jy - r, r * 2, r * 2);
  }
  for (const [color, rects] of batches) {
    ctx.fillStyle = color;
    for (let j = 0; j < rects.length; j += 4) {
      ctx.fillRect(rects[j], rects[j + 1], rects[j + 2], rects[j + 3]);
    }
  }
}

function stopAnimLoop(): void {
  if (animIntervalId !== null) {
    clearInterval(animIntervalId);
    animIntervalId = null;
  }
}

function startAnimLoop(): void {
  stopAnimLoop();
  const ctx = animCtx;
  const dots = animDots;
  const cw = animCanvasWidth;
  if (!ctx || !dots) return;
  animIntervalId = setInterval(
    () => {
      renderAnimFrame(ctx, dots, animFrameIdx, cw);
      animFrameIdx = (animFrameIdx + animFrameStep) % NUM_FRAMES;
    },
    Math.round(1000 / 60)
  );
}

function switchToGlyph(index: number): void {
  if (!cachedImages || index >= cachedImages.length || !animCtx) return;
  const pixels = base64ToUint8(cachedImages[index]);
  animDots = buildAnimDots(pixels, cachedWidth, cachedHeight, animCanvasWidth);
  animFrameIdx = 0;
  startAnimLoop();
}

// ── Crypto helpers ───────────────────────────────────────────────────

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
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Message handling ─────────────────────────────────────────────────

interface WorkerMessage {
  id: number;
  type:
    | 'init'
    | 'init-port'
    | 'decrypt'
    | 'encrypt'
    | 'animate'
    | 'switch-glyph'
    | 'stop-animate'
    | 'restart-animate';
  encryptedB64?: string;
  serverPubKeyB64?: string;
  payload?: object;
  port?: MessagePort;
  index?: number;
  canvas?: OffscreenCanvas;
  canvasWidth?: number;
  frameStep?: number;
}

let messagePort: MessagePort | null = null;

function respond(msg: Record<string, unknown>, transfer?: Transferable[]): void {
  if (messagePort) {
    messagePort.postMessage(msg, { transfer });
  } else if (transfer?.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self.postMessage as any)(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

// eslint-disable-next-line complexity -- message type dispatcher; each case is a distinct operation
async function handleWorkerMessage(data: WorkerMessage): Promise<void> {
  const { id, type } = data;

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
        respond({ id, rawPublicKey });
        break;
      }

      case 'decrypt': {
        if (!privateKey) throw new Error('Worker not initialized');
        const { encryptedB64, serverPubKeyB64 } = data;
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

        const reversed = sboxReverse(new Uint8Array(decrypted));
        const jsonData = JSON.parse(new TextDecoder().decode(reversed)) as {
          images?: string[];
          masks?: string[];
          width?: number;
          height?: number;
          maskWidth?: number;
          maskHeight?: number;
        };

        // Cache images locally — NEVER send pixel arrays back to main thread.
        // v12 hooks worker.addEventListener('message') looking for d?.data?.images.
        // We respond with empty-string placeholders: correct count, no pixel data.
        cachedImages = jsonData.images ?? jsonData.masks ?? null;
        cachedWidth = jsonData.width ?? jsonData.maskWidth ?? 0;
        cachedHeight = jsonData.height ?? jsonData.maskHeight ?? 0;
        const count = cachedImages?.length ?? 0;

        respond({
          id,
          data: {
            images: new Array<string>(count).fill(''),
            width: cachedWidth,
            height: cachedHeight,
          },
        });
        break;
      }

      case 'animate': {
        const { index, canvas, canvasWidth = 280, frameStep = 1 } = data;
        if (index === undefined || !canvas) throw new Error('Missing animate params');
        if (!cachedImages) throw new Error('No cached images — call decrypt first');

        animCanvas = canvas;
        animCtx = canvas.getContext('2d');
        animCanvasWidth = canvasWidth;
        animFrameStep = frameStep;
        switchToGlyph(index);
        respond({ id, ok: true });
        break;
      }

      case 'restart-animate': {
        // Canvas already transferred — just restart animation (StrictMode remount)
        if (!animCanvas || !animCtx) throw new Error('No canvas — call animate first');
        const idx = data.index ?? 0;
        animFrameStep = data.frameStep ?? animFrameStep;
        switchToGlyph(idx);
        respond({ id, ok: true });
        break;
      }

      case 'switch-glyph': {
        if (data.index === undefined) throw new Error('Missing index');
        switchToGlyph(data.index);
        respond({ id, ok: true });
        break;
      }

      case 'stop-animate': {
        stopAnimLoop();
        respond({ id, ok: true });
        break;
      }

      case 'encrypt': {
        if (!privateKey) throw new Error('Worker not initialized');
        const { payload, serverPubKeyB64 } = data;
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
        respond({ id, encrypted: result }, [result.buffer]);
        break;
      }
    }
  } catch (err) {
    respond({ id, error: (err as Error).message });
  }
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type } = e.data;

  if (type === 'init-port' && e.data.port) {
    messagePort = e.data.port;
    messagePort.onmessage = (portEvent: MessageEvent<WorkerMessage>) => {
      handleWorkerMessage(portEvent.data);
    };
    return;
  }

  await handleWorkerMessage(e.data);
};
