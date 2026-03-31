/** Bio-specific API bridge — captures pristine native refs at construction time */

import { deflateRaw } from 'pako';
import type { AggregateFeatures } from '../../server/types';

const SIGINT_TCP_PROBE_URL =
  (import.meta.env.VITE_SIGINT_TCP_PROBE_URL as string | undefined) ??
  'https://dev-jw-tcp-probe.argus.pw/';
const SIGINT_H2_PROBE_URL =
  (import.meta.env.VITE_SIGINT_H2_PROBE_URL as string | undefined) ?? 'https://dev-jw-h2.argus.pw/';

export interface ApiHandler {
  get?: () => unknown;
  call?: (thisArg: unknown, args: unknown[]) => unknown;
}

export class ApiBridge {
  private readonly handlers = new Map<number, ApiHandler>();

  register(apiId: number, handler: ApiHandler): void {
    this.handlers.set(apiId, handler);
  }

  get(apiId: number): unknown {
    const handler = this.handlers.get(apiId);
    if (!handler?.get) throw new Error(`API ${apiId}: no getter`);
    return handler.get();
  }

  call(apiId: number, _thisArg: unknown, args: unknown[]): unknown {
    const handler = this.handlers.get(apiId);
    if (!handler?.call) throw new Error(`API ${apiId}: no call handler`);
    return handler.call(_thisArg, args);
  }

  has(apiId: number): boolean {
    return this.handlers.has(apiId);
  }
}

/** Bridge API IDs */
export const BridgeApi = {
  NAV_WEBDRIVER: 0x01,
  WIN_GET_OWN_PROP_NAMES: 0x02,
  DOC_GET_OWN_PROP_NAMES: 0x03,
  FN_TO_STRING: 0x04,
  PTR_GET_COALESCED_STR: 0x05,
  PTR_GET_PREDICTED_STR: 0x06,
  PERF_NOW_STR: 0x07,
  GET_STROKE_DATA: 0x08,
  GET_FEATURES: 0x09,
  IMMOLATE: 0x0a,
  NATIVE_REGEX_TEST: 0x0b,
  IFRAME_TO_STRING: 0x0c,
  GET_OWN_PROP_DESCRIPTOR: 0x0d,

  // New detection APIs
  PLUGINS_LENGTH: 0x0e,
  CHROME_EXISTS: 0x0f,
  NAV_WEBDRIVER_OWN: 0x10,
  PHANTOM_WEBDRIVER: 0x11,
  SCREEN_NO_TASKBAR: 0x12,

  // Crypto context APIs
  GET_PAYLOAD_JSON: 0x13,
  GET_SERVER_PUB_KEY: 0x14,

  // Cross-realm toString getters (use iframe toString on pre-known functions)
  XREALM_COALESCED_STR: 0x15,
  XREALM_PREDICTED_STR: 0x16,
  XREALM_PERF_NOW_STR: 0x17,

  // Async crypto APIs (called via API_CALL_ASYNC)
  ECDH_GENERATE_KEY: 0x30,
  ECDH_EXPORT_RAW: 0x31,
  ECDH_DERIVE_ENCRYPT: 0x32,

  // Async sigint probe APIs (called via API_CALL_ASYNC)
  SIGINT_PROBES: 0x33,
} as const;

interface Stroke {
  points: {
    x: number;
    y: number;
    t: number;
    coalescedCount: number;
    movementX: number;
    movementY: number;
  }[];
}

export interface BridgeContext {
  getStrokes: () => Stroke[];
  getFeatures: () => AggregateFeatures;
  onImmolate: (signals: string[]) => void;
  getPayload?: () => Record<string, unknown>;
  getServerPubKey?: () => string;
  immolateFeatures?: (features: AggregateFeatures) => AggregateFeatures;
}

const HIDDEN_CSS = 'position:absolute;width:0;height:0;border:0;overflow:hidden;clip:rect(0,0,0,0)';
const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

/** Convert Uint8Array to base64 (chunked to avoid stack overflow) */
function uint8ToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

/** Convert base64 to Uint8Array */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a bio bridge, capturing pristine references BEFORE any bot patching.
 * Must be called as early as possible in the page lifecycle.
 */
export function createBioBridge(ctx: BridgeContext): ApiBridge {
  const bridge = new ApiBridge();

  // Capture pristine references at construction time — before any bot patching
  const pristineFetch = window.fetch.bind(window);
  const pristineToString = Function.prototype.toString;
  const pristineGetOwnPropertyNames = Object.getOwnPropertyNames;
  const pristineGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeCodeRe = /\[native code]/;
  const pristineRegExpTest = RegExp.prototype.test;

  // Capture toString of key APIs
  let coalescedStr = '';
  let predictedStr = '';
  let perfNowStr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let coalescedFn: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let predictedFn: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let perfNowFn: any = null;
  try {
    coalescedFn = PointerEvent.prototype.getCoalescedEvents;
    coalescedStr = pristineToString.call(coalescedFn);
  } catch {
    /* unsupported browser */
  }
  try {
    predictedFn = PointerEvent.prototype.getPredictedEvents;
    predictedStr = pristineToString.call(predictedFn);
  } catch {
    /* unsupported browser */
  }
  try {
    perfNowFn = Performance.prototype.now;
    perfNowStr = pristineToString.call(perfNowFn);
  } catch {
    /* unsupported browser */
  }

  // Get clean toString + pristine crypto from nested iframe (PHANTOM_DARKNESS bypass)
  let iframeToString: typeof Function.prototype.toString | null = null;
  let iframeCrypto: SubtleCrypto | null = null;
  try {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.style.cssText = HIDDEN_CSS;
    shadow.appendChild(iframe);
    document.body.appendChild(host);
    const win = iframe.contentWindow;
    if (win) {
      const doc1 = win.document;
      const iframe2 = doc1.createElement('iframe');
      iframe2.style.cssText = HIDDEN_CSS;
      doc1.body.appendChild(iframe2);
      const win2 = iframe2.contentWindow;
      if (win2) {
        iframeToString = (
          win2 as unknown as {
            Function: { prototype: { toString: typeof Function.prototype.toString } };
          }
        ).Function.prototype.toString;

        // Capture pristine crypto.subtle from nested iframe — unhookable by bot
        try {
          iframeCrypto = (win2 as unknown as { crypto: Crypto }).crypto.subtle;
        } catch {
          /* crypto unavailable in iframe */
        }
      }
    }
    setTimeout(() => host.remove(), 0);
  } catch {
    /* iframe creation failed */
  }

  // ─── Existing detection APIs ────────────────────────────────────

  // 0x01: navigator.webdriver
  bridge.register(BridgeApi.NAV_WEBDRIVER, {
    get: () => (navigator as unknown as Record<string, unknown>).webdriver,
  });

  // 0x02: Object.getOwnPropertyNames(window)
  bridge.register(BridgeApi.WIN_GET_OWN_PROP_NAMES, {
    call: () => pristineGetOwnPropertyNames(window),
  });

  // 0x03: Object.getOwnPropertyNames(document)
  bridge.register(BridgeApi.DOC_GET_OWN_PROP_NAMES, {
    call: () => pristineGetOwnPropertyNames(document),
  });

  // 0x04: Function.prototype.toString (pristine) — call with arg[0] as the function
  bridge.register(BridgeApi.FN_TO_STRING, {
    call: (_thisArg, args) => {
      try {
        return pristineToString.call(args[0]);
      } catch {
        return '';
      }
    },
  });

  // 0x05: toString of getCoalescedEvents (pre-captured)
  bridge.register(BridgeApi.PTR_GET_COALESCED_STR, {
    get: () => coalescedStr,
  });

  // 0x06: toString of getPredictedEvents (pre-captured)
  bridge.register(BridgeApi.PTR_GET_PREDICTED_STR, {
    get: () => predictedStr,
  });

  // 0x07: toString of Performance.prototype.now (pre-captured)
  bridge.register(BridgeApi.PERF_NOW_STR, {
    get: () => perfNowStr,
  });

  // 0x08: get stroke data from main thread
  bridge.register(BridgeApi.GET_STROKE_DATA, {
    call: () => ctx.getStrokes(),
  });

  // 0x09: get features computed by normal JS
  bridge.register(BridgeApi.GET_FEATURES, {
    call: () => ctx.getFeatures(),
  });

  // 0x0A: immolate callback
  bridge.register(BridgeApi.IMMOLATE, {
    call: (_thisArg, args) => {
      ctx.onImmolate(args[0] as string[]);
    },
  });

  // 0x0B: pristine RegExp.prototype.test
  bridge.register(BridgeApi.NATIVE_REGEX_TEST, {
    call: (_thisArg, args) => pristineRegExpTest.call(nativeCodeRe, args[0] as string),
  });

  // 0x0C: cross-realm toString from fresh iframe
  bridge.register(BridgeApi.IFRAME_TO_STRING, {
    call: (_thisArg, args) => {
      if (!iframeToString) return '';
      try {
        return iframeToString.call(args[0]);
      } catch {
        return '';
      }
    },
  });

  // 0x0D: pristine Object.getOwnPropertyDescriptor
  bridge.register(BridgeApi.GET_OWN_PROP_DESCRIPTOR, {
    call: (_thisArg, args) => {
      try {
        return pristineGetOwnPropertyDescriptor(args[0] as object, args[1] as string);
      } catch {
        return;
      }
    },
  });

  // ─── New detection APIs ─────────────────────────────────────────

  // 0x0E: navigator.plugins.length
  bridge.register(BridgeApi.PLUGINS_LENGTH, {
    get: () => {
      try {
        return navigator.plugins.length;
      } catch {
        return 0;
      }
    },
  });

  // 0x0F: !!window.chrome
  bridge.register(BridgeApi.CHROME_EXISTS, {
    get: () => !!(window as unknown as Record<string, unknown>).chrome,
  });

  // 0x10: navigator has own 'webdriver' property (patched via defineProperty)
  bridge.register(BridgeApi.NAV_WEBDRIVER_OWN, {
    get: () => {
      try {
        return pristineGetOwnPropertyDescriptor(navigator, 'webdriver') !== undefined;
      } catch {
        return false;
      }
    },
  });

  // 0x11: phantom iframe webdriver check
  bridge.register(BridgeApi.PHANTOM_WEBDRIVER, {
    call: () => {
      try {
        const el = document.createElement('iframe');
        el.style.cssText = HIDDEN_CSS;
        document.body.appendChild(el);
        const wd = (el.contentWindow as unknown as { navigator: { webdriver: boolean } }).navigator
          .webdriver;
        el.remove();
        return wd;
      } catch {
        return;
      }
    },
  });

  // 0x12: screen dimensions match (no taskbar = virtual display)
  bridge.register(BridgeApi.SCREEN_NO_TASKBAR, {
    get: () => screen.width === screen.availWidth && screen.height === screen.availHeight,
  });

  // 0x15: cross-realm toString of getCoalescedEvents
  bridge.register(BridgeApi.XREALM_COALESCED_STR, {
    get: () => {
      if (!iframeToString || !coalescedFn) return '';
      try {
        return iframeToString.call(coalescedFn);
      } catch {
        return '';
      }
    },
  });

  // 0x16: cross-realm toString of getPredictedEvents
  bridge.register(BridgeApi.XREALM_PREDICTED_STR, {
    get: () => {
      if (!iframeToString || !predictedFn) return '';
      try {
        return iframeToString.call(predictedFn);
      } catch {
        return '';
      }
    },
  });

  // 0x17: cross-realm toString of Performance.prototype.now
  bridge.register(BridgeApi.XREALM_PERF_NOW_STR, {
    get: () => {
      if (!iframeToString || !perfNowFn) return '';
      try {
        return iframeToString.call(perfNowFn);
      } catch {
        return '';
      }
    },
  });

  // ─── Crypto context APIs ────────────────────────────────────────

  // 0x13: get payload JSON (injects vmHash + handles immolation)
  bridge.register(BridgeApi.GET_PAYLOAD_JSON, {
    call: (_thisArg, args) => {
      if (!ctx.getPayload) return '';
      const payload = ctx.getPayload();
      const vmHash = args[0] as string;
      const vmSignals = args[1] as string[];
      payload.vmHash = vmHash;
      if (vmSignals && vmSignals.length > 0) {
        if (ctx.immolateFeatures) {
          payload.features = ctx.immolateFeatures(payload.features as AggregateFeatures);
        }
        const existing = (payload.tamperedApis as string[]) || [];
        existing.push(...vmSignals);
        payload.tamperedApis = existing;
      }
      return JSON.stringify(payload);
    },
  });

  // 0x14: get server public key from context
  bridge.register(BridgeApi.GET_SERVER_PUB_KEY, {
    get: () => (ctx.getServerPubKey ? ctx.getServerPubKey() : ''),
  });

  // ─── Async crypto APIs (called via API_CALL_ASYNC) ──────────────

  // 0x30: ECDH key generation using pristine iframe crypto
  bridge.register(BridgeApi.ECDH_GENERATE_KEY, {
    call: async () => {
      const subtle = iframeCrypto ?? crypto.subtle;
      return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    },
  });

  // 0x31: export raw public key → base64 string
  bridge.register(BridgeApi.ECDH_EXPORT_RAW, {
    call: async (_thisArg, args) => {
      const publicKey = args[0] as CryptoKey;
      const subtle = iframeCrypto ?? crypto.subtle;
      const rawPub = await subtle.exportKey('raw', publicKey);
      return uint8ToBase64(new Uint8Array(rawPub));
    },
  });

  // 0x32: full ECDH derive + compress + encrypt pipeline
  // Sigint probes (tcp + h2) are fired at entry using the pristine fetch ref captured
  // at bridge construction time, running concurrently with ECDH key derivation.
  // Tokens are injected into the payload JSON before compression so they travel
  // inside the encrypted envelope — a bot cannot see or forge them.
  bridge.register(BridgeApi.ECDH_DERIVE_ENCRYPT, {
    call: async (_thisArg, args) => {
      const privateKey = args[0] as CryptoKey;
      const serverPubKeyB64 = args[1] as string;
      const payloadJSON = args[2] as string;

      // 1. Fire sigint probes immediately — concurrent with ECDH derivation below
      type TokenResp = { token?: string };
      const probePromise = Promise.all([
        pristineFetch(SIGINT_TCP_PROBE_URL)
          .then((r) => r.json() as Promise<TokenResp>)
          .catch(() => ({}) as TokenResp),
        pristineFetch(SIGINT_H2_PROBE_URL)
          .then((r) => r.json() as Promise<TokenResp>)
          .catch(() => ({}) as TokenResp),
      ]);

      const subtle = iframeCrypto ?? crypto.subtle;

      // 2. Import server's raw public key
      const serverPubBytes = base64ToUint8(serverPubKeyB64);
      const serverPubKey = await subtle.importKey(
        'raw',
        serverPubBytes.buffer as ArrayBuffer,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      // 3. ECDH → shared secret → HKDF → AES-256-GCM key
      const sharedBits = await subtle.deriveBits(
        { name: 'ECDH', public: serverPubKey },
        privateKey,
        256
      );
      const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
      const salt = new TextEncoder().encode(new Date().toISOString().slice(0, 10));
      const aesKey = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );

      // 4. Await probes and inject tokens into payload (probes ran concurrently above)
      const [tcpRes, h2Res] = await probePromise;
      const payload = JSON.parse(payloadJSON) as Record<string, unknown>;
      if (tcpRes.token) payload.tcpProbeToken = tcpRes.token;
      if (h2Res.token) payload.h2ProbeToken = h2Res.token;
      const enrichedJSON = JSON.stringify(payload);

      // 5. Compress (pako deflateRaw)
      const compressed = deflateRaw(new TextEncoder().encode(enrichedJSON));

      // 6. Encrypt (AES-256-GCM with random 12-byte IV)
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        compressed.buffer as ArrayBuffer
      );

      // 7. Pack: [iv(12) | ciphertext+tag]
      const ctBytes = new Uint8Array(ciphertext);
      const packed = new Uint8Array(12 + ctBytes.length);
      packed.set(iv);
      packed.set(ctBytes, 12);
      return packed;
    },
  });

  return bridge;
}
