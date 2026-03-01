/** Bio-specific API bridge — captures pristine native refs at construction time */

import type { AggregateFeatures } from '../../server/types';

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
}

const HIDDEN_CSS = 'position:absolute;width:0;height:0;border:0;overflow:hidden;clip:rect(0,0,0,0)';

/**
 * Create a bio bridge, capturing pristine references BEFORE any bot patching.
 * Must be called as early as possible in the page lifecycle.
 */
export function createBioBridge(ctx: BridgeContext): ApiBridge {
  const bridge = new ApiBridge();

  // Capture pristine references at construction time
  const pristineToString = Function.prototype.toString;
  const pristineGetOwnPropertyNames = Object.getOwnPropertyNames;
  const pristineGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeCodeRe = /\[native code]/;
  const pristineRegExpTest = RegExp.prototype.test;

  // Capture toString of key APIs
  let coalescedStr = '';
  let predictedStr = '';
  let perfNowStr = '';
  try {
    coalescedStr = pristineToString.call(PointerEvent.prototype.getCoalescedEvents);
  } catch {
    /* unsupported browser */
  }
  try {
    predictedStr = pristineToString.call(PointerEvent.prototype.getPredictedEvents);
  } catch {
    /* unsupported browser */
  }
  try {
    perfNowStr = pristineToString.call(Performance.prototype.now);
  } catch {
    /* unsupported browser */
  }

  // Get clean toString from iframe (PHANTOM_DARKNESS bypass)
  let iframeToString: typeof Function.prototype.toString | null = null;
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
      }
    }
    setTimeout(() => host.remove(), 0);
  } catch {
    /* iframe creation failed */
  }

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

  return bridge;
}
