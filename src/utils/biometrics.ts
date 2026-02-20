import type { Stroke, StrokePoint } from '../components/DrawingCanvas';

export interface NormalizedStroke {
  points: {
    x: number;
    y: number;
    t: number;
    pressure: number;
    tiltX: number;
    tiltY: number;
    width: number;
    height: number;
    coalescedCount: number;
    coalescedSpoofed: boolean;
    movementX: number;
    movementY: number;
    predictedCount: number;
    timestampDelta: number;
  }[];
  startTime: number;
  endTime: number;
}

export interface ConfidenceSnapshot {
  t: number;
  digitIndex: number;
  targetConf: number;
  topDigit: number;
  topConf: number;
}

export interface VerdictResult {
  verdict: 'human' | 'bot' | 'uncertain';
  confidence: number;
  neighborCount: number;
  heuristicLabel: string;
  token?: string;
  returnUrl?: string;
}

export interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
  strokes: NormalizedStroke[];
  imageData: number[];
}

// ── Biometric feature computation ────────────────────────────────────

/** Check if the browser natively supports getCoalescedEvents */
const COALESCED_SUPPORTED =
  typeof PointerEvent !== 'undefined' &&
  typeof PointerEvent.prototype.getCoalescedEvents === 'function';

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const variance = (a: number[]) => {
  const m = avg(a);
  return a.length ? a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length : 0;
};

/** Compute per-point speeds and accelerations across all strokes */
function computeKinematics(strokes: Stroke[]) {
  const speeds: number[] = [];
  const accelerations: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 1];
      const p1 = stroke.points[i];
      const dt = p1.t - p0.t;
      if (dt > 0) {
        speeds.push(Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt);
      }
    }
    for (let i = 2; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 2];
      const p1 = stroke.points[i - 1];
      const p2 = stroke.points[i];
      const dt1 = p1.t - p0.t;
      const dt2 = p2.t - p1.t;
      if (dt1 > 0 && dt2 > 0) {
        const s1 = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt1;
        const s2 = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2) / dt2;
        accelerations.push((s2 - s1) / ((dt1 + dt2) / 2));
      }
    }
  }
  const jerks: number[] = [];
  for (let i = 1; i < accelerations.length; i++) {
    jerks.push(Math.abs(accelerations[i] - accelerations[i - 1]));
  }
  return { speeds, jerks };
}

/** Ratio of inter-point deltas aligned to common display refresh rates.
 *  Real pointer events cluster around rAF frame boundaries;
 *  CDP-injected events arrive at arbitrary times. */
function computeRafCadenceRatio(strokes: Stroke[]): number {
  const FRAME_PERIODS = [16.667, 11.111, 8.333, 6.944]; // 60, 90, 120, 144 Hz
  const TOLERANCE_MS = 2.5;
  const dts: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt > 0) dts.push(dt);
    }
  }
  if (dts.length === 0) return 0;
  let best = 0;
  for (const framePeriod of FRAME_PERIODS) {
    let onGrid = 0;
    for (const dt of dts) {
      const remainder = dt % framePeriod;
      if (remainder < TOLERANCE_MS || framePeriod - remainder < TOLERANCE_MS) onGrid++;
    }
    best = Math.max(best, onGrid / dts.length);
  }
  return best;
}

/** Average fit of each stroke's velocity profile to a bell curve (min-jerk model).
 *  Human strokes follow slow-fast-slow; bots tend to be more uniform. */
function computeVelocityBellScore(strokes: Stroke[]): number {
  let bellScoreSum = 0;
  let bellCount = 0;
  for (const stroke of strokes) {
    if (stroke.points.length < 5) continue;
    const velocities: number[] = [];
    for (let i = 1; i < stroke.points.length; i++) {
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      velocities.push(dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0);
    }
    const maxV = Math.max(...velocities);
    if (maxV === 0) continue;
    const normalized = velocities.map((v) => v / maxV);
    let error = 0;
    for (let i = 0; i < normalized.length; i++) {
      const expected = Math.sin(Math.PI * ((i + 0.5) / normalized.length));
      error += Math.abs(normalized[i] - expected);
    }
    bellScoreSum += 1 - error / normalized.length;
    bellCount++;
  }
  return bellCount > 0 ? bellScoreSum / bellCount : 0;
}

/** Coalesced event stats: ratio of moves with coalesced events, and spoofed ratio */
function computeCoalescedStats(allPoints: StrokePoint[]) {
  const movePoints = allPoints.slice(1); // skip first point (pointerdown)
  if (movePoints.length === 0) return { coalescedRatio: 0, coalescedSpoofedRatio: 0 };
  const coalescedMoves = movePoints.filter((p) => p.coalescedCount > 0).length;
  const spoofedMoves = movePoints.filter((p) => p.coalescedSpoofed).length;
  return {
    coalescedRatio: coalescedMoves / movePoints.length,
    coalescedSpoofedRatio: spoofedMoves / movePoints.length,
  };
}

const EMPTY_FEATURES = {
  strokeCount: 0,
  totalPoints: 0,
  avgSpeed: 0,
  speedVariance: 0,
  maxSpeed: 0,
  avgPressure: 0,
  pressureVariance: 0,
  avgContactWidth: 0,
  avgContactHeight: 0,
  totalDurationMs: 0,
  avgTimeBetweenStrokes: 0,
  eventFrequencyHz: 0,
  avgJerk: 0,
  coalescedRatio: 0,
  coalescedSpoofedRatio: 0,
  rafCadenceRatio: 0,
  velocityBellScore: 0,
  interStrokePauseCV: 0,
  coalescedSupported: COALESCED_SUPPORTED,
  zeroMovementRatio: 0,
  avgPredictedCount: 0,
  avgTimestampDelta: 0,
};

export function computeFeatures(strokes: Stroke[]) {
  const allPoints: StrokePoint[] = strokes.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return { ...EMPTY_FEATURES, strokeCount: strokes.length, totalPoints: allPoints.length };
  }

  const { speeds, jerks } = computeKinematics(strokes);
  const pressures = allPoints.map((p) => p.pressure);
  const widths = allPoints.map((p) => p.width);
  const heights = allPoints.map((p) => p.height);
  const strokeGaps: number[] = [];
  for (let i = 1; i < strokes.length; i++) {
    strokeGaps.push(strokes[i].startTime - strokes[i - 1].endTime);
  }
  const totalTime = allPoints[allPoints.length - 1].t - allPoints[0].t;
  const coalesced = computeCoalescedStats(allPoints);

  // Inter-stroke pause CV: humans have bimodal pauses (within/between chars) → high CV
  const gapAvg = avg(strokeGaps);
  const gapStddev = Math.sqrt(variance(strokeGaps));
  const interStrokePauseCV = gapAvg > 0 ? gapStddev / gapAvg : 0;

  // CDP kill signals: movementX/Y, getPredictedEvents, timeStamp delta
  const movePoints = allPoints.slice(1); // skip pointerdown
  // zeroMovementRatio: % of move points where coords changed but both movementX/Y are 0
  // Real browser: ~0%. CDP dispatched events: ~100% (movementX/Y not synthesized).
  let zeroMovementCount = 0;
  for (const p of movePoints) {
    if (p.movementX === 0 && p.movementY === 0) zeroMovementCount++;
  }
  const zeroMovementRatio = movePoints.length > 0 ? zeroMovementCount / movePoints.length : 0;

  // avgPredictedCount: avg of predictedCount across move points. Real: 1-3. CDP: 0.
  const avgPredictedCount = avg(movePoints.map((p) => p.predictedCount));

  // avgTimestampDelta: avg (performance.now() - event.timeStamp). Real: 4-16ms. CDP: ~0ms.
  const avgTimestampDelta = avg(allPoints.map((p) => p.timestampDelta));

  return {
    strokeCount: strokes.length,
    totalPoints: allPoints.length,
    avgSpeed: avg(speeds),
    speedVariance: variance(speeds),
    maxSpeed: speeds.length ? Math.max(...speeds) : 0,
    avgPressure: avg(pressures),
    pressureVariance: variance(pressures),
    avgContactWidth: avg(widths),
    avgContactHeight: avg(heights),
    totalDurationMs: totalTime,
    avgTimeBetweenStrokes: avg(strokeGaps),
    eventFrequencyHz: totalTime > 0 ? (allPoints.length / totalTime) * 1000 : 0,
    avgJerk: avg(jerks),
    ...coalesced,
    rafCadenceRatio: computeRafCadenceRatio(strokes),
    velocityBellScore: computeVelocityBellScore(strokes),
    interStrokePauseCV,
    coalescedSupported: COALESCED_SUPPORTED,
    zeroMovementRatio,
    avgPredictedCount,
    avgTimestampDelta,
  };
}

// ── Prototype tamper detection ──────────────────────────────────────
// Lightweight checks inspired by ms-argus-web's lies module.
// Tests APIs we rely on for bot detection (coalescedEvents, etc.).
// If any are tampered with (toString, descriptor, etc.), flag it.

const NATIVE_RE = /\{\s*\[native code\]\s*\}/;
const HIDDEN_IFRAME_CSS = 'display:none;width:0;height:0;border:none';

function isNative(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    return NATIVE_RE.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

function hasCleanDescriptors(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    // Native functions should NOT have 'prototype' as own property
    // (instance methods like getCoalescedEvents don't have .prototype)
    const names = Object.getOwnPropertyNames(fn);
    if (names.includes('prototype') || names.includes('arguments') || names.includes('caller')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Check critical APIs for tampering. Returns list of tampered API names. */
export function detectTampering(): string[] {
  const tampered: string[] = [];

  // APIs we depend on for bot detection signals
  const checks: [string, () => unknown][] = [
    ['PointerEvent.prototype.getCoalescedEvents', () => PointerEvent.prototype.getCoalescedEvents],
    ['PointerEvent.prototype.getPredictedEvents', () => PointerEvent.prototype.getPredictedEvents],
    ['Element.prototype.getBoundingClientRect', () => Element.prototype.getBoundingClientRect],
    ['HTMLCanvasElement.prototype.getContext', () => HTMLCanvasElement.prototype.getContext],
    ['Performance.prototype.now', () => Performance.prototype.now],
  ];

  for (const [name, getFn] of checks) {
    try {
      const fn = getFn();
      // Skip if the API doesn't exist (unsupported browser, not tampering)
      if (typeof fn === 'undefined') continue;
      if (!isNative(fn) || !hasCleanDescriptors(fn)) {
        tampered.push(name);
      }
    } catch {
      // If the API doesn't exist (old browser), skip — not tampering
    }
  }

  // Also check if Function.prototype.toString itself has been tampered
  // (bot could override toString to hide its patches)
  try {
    const toStr = Function.prototype.toString;
    const toStrStr = Function.prototype.toString.call(toStr);
    if (!NATIVE_RE.test(toStrStr)) {
      tampered.push('Function.prototype.toString');
    }
  } catch {
    tampered.push('Function.prototype.toString');
  }

  // Cross-realm toString check (PHANTOM_DARKNESS)
  tampered.push(...detectCrossRealmTampering(checks));

  return tampered;
}

/** Cross-realm toString: compare main-frame toString against a clean copy from
 *  a double-nested iframe. Bot's addInitScript patches main frame but not dynamic iframes. */
function detectCrossRealmTampering(checks: [string, () => unknown][]): string[] {
  const signals: string[] = [];
  const cleanToString = getCrossRealmToString();
  if (!cleanToString) return signals;

  for (const [name, getFn] of checks) {
    try {
      const fn = getFn();
      if (typeof fn !== 'function') continue;
      const mainResult = Function.prototype.toString.call(fn);
      const crossResult = cleanToString.call(fn);
      if (NATIVE_RE.test(mainResult) && !NATIVE_RE.test(crossResult)) {
        signals.push(`xrealm:${name}`);
      }
    } catch {
      /* ignore */
    }
  }
  return signals;
}

/** Get a clean Function.prototype.toString from a double-nested iframe chain.
 *  Bot's addInitScript patches the main frame but not dynamically created iframes. */
function getCrossRealmToString(): typeof Function.prototype.toString | null {
  try {
    // Create first iframe
    const host1 = document.createElement('div');
    const shadow1 = host1.attachShadow({ mode: 'closed' });
    const iframe1 = document.createElement('iframe');
    iframe1.style.cssText = HIDDEN_IFRAME_CSS;
    shadow1.appendChild(iframe1);
    document.body.appendChild(host1);
    const win1 = iframe1.contentWindow;
    if (!win1) {
      host1.remove();
      return null;
    }

    // Create second iframe inside the first (double-nested)
    const doc1 = win1.document;
    const iframe2 = doc1.createElement('iframe');
    iframe2.style.cssText = HIDDEN_IFRAME_CSS;
    doc1.body.appendChild(iframe2);
    const win2 = iframe2.contentWindow;
    if (!win2) {
      host1.remove();
      return null;
    }

    // Capture the clean toString from the innermost iframe
    const cleanToString = (
      win2 as unknown as {
        Function: { prototype: { toString: typeof Function.prototype.toString } };
      }
    ).Function.prototype.toString;

    // Clean up after capturing
    setTimeout(() => host1.remove(), 0);
    return cleanToString;
  } catch {
    return null;
  }
}

// ── CDP / Automation detection ──────────────────────────────────────
// Detects Chrome DevTools Protocol usage, browser automation frameworks,
// and headless browser artifacts. Returns prefixed identifiers that merge
// into the existing tamperedApis instant-kill path.

/** Create a hidden iframe inside a closed shadow DOM and return its window. */
function getPhantomWindow(): Window | null {
  try {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.style.cssText = HIDDEN_IFRAME_CSS;
    shadow.appendChild(iframe);
    document.body.appendChild(host);
    const win = iframe.contentWindow;
    // Clean up after a tick so the iframe has time to initialize
    setTimeout(() => host.remove(), 0);
    return win;
  } catch {
    return null;
  }
}

/** Check for navigator.webdriver flag */
function checkWebdriver(): string | null {
  try {
    if ((navigator as unknown as Record<string, unknown>).webdriver === true)
      return 'cdp:webdriver';
  } catch {
    /* ignore */
  }
  return null;
}

/** Check for ChromeDriver globals (cdc_ prefixed properties) */
function checkCdcGlobals(): string | null {
  try {
    for (const key of Object.getOwnPropertyNames(document)) {
      if (/^(\$)?cdc_/.test(key)) return 'cdp:cdc_global';
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Check for Playwright __pw_* bindings */
function checkPwBindings(): string | null {
  try {
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^__pw_/.test(key)) return 'cdp:pw_binding';
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Check for phantom iframe webdriver mismatch (stealth plugin detection) */
function checkPhantomMismatch(): string | null {
  try {
    const mainWebdriver = (navigator as unknown as Record<string, unknown>).webdriver;
    const phantom = getPhantomWindow();
    if (!phantom) return null;
    const iframeWebdriver = (phantom.navigator as unknown as Record<string, unknown>).webdriver;
    if (!mainWebdriver && iframeWebdriver === true) return 'cdp:phantom_mismatch';
  } catch {
    /* ignore */
  }
  return null;
}

/** Check WebGL renderer for SwiftShader (headless Chrome indicator) */
function checkSwiftShader(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl && gl instanceof WebGLRenderingContext) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
        if (/swiftshader/i.test(renderer)) return 'cdp:swiftshader';
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Automation framework globals to check
const AUTOMATION_GLOBALS: [string, () => unknown][] = [
  ['playwright', () => (window as unknown as Record<string, unknown>).__playwright],
  ['puppeteer', () => (window as unknown as Record<string, unknown>).__puppeteer],
  ['phantom', () => (window as unknown as Record<string, unknown>)._phantom],
  ['nightmare', () => (window as unknown as Record<string, unknown>).__nightmare],
  ['callPhantom', () => (window as unknown as Record<string, unknown>).callPhantom],
  [
    'selenium_unwrapped',
    () => (document as unknown as Record<string, unknown>).__selenium_unwrapped,
  ],
  [
    'webdriver_evaluate',
    () => (document as unknown as Record<string, unknown>).__webdriver_evaluate,
  ],
  ['driver_evaluate', () => (document as unknown as Record<string, unknown>).__driver_evaluate],
];

/** Detect CDP usage, automation globals, and headless artifacts. */
export function detectCDP(): string[] {
  const signals: string[] = [];

  for (const check of [
    checkWebdriver,
    checkCdcGlobals,
    checkPwBindings,
    checkPhantomMismatch,
    checkSwiftShader,
  ]) {
    const s = check();
    if (s) signals.push(s);
  }

  for (const [name, getFn] of AUTOMATION_GLOBALS) {
    try {
      if (getFn() != null) signals.push(`cdp:${name}`);
    } catch {
      /* ignore */
    }
  }

  // Client litter detection: compare window globals against a fresh iframe
  // to find bot-injected globals (e.g. __decryptedChallenge, __nextFlash)
  const litter = checkClientLitter();
  if (litter.length > 0) {
    const top5 = litter.slice(0, 5).join(',');
    signals.push(`cdp:litter(${top5})`);
  }

  return signals;
}

/** Known bot-injected globals — only these trigger litter detection.
 *  Whitelist approach: browser extensions inject too many random globals
 *  to reliably blacklist, so we only flag patterns seen in actual bots. */
const BOT_LITTER_RE =
  /^(__decryptedChallenge|__nextFlash|__captcha|__solver|__bot|__scrape|__crawl|__auto|__inject|__hook|__intercept|__proxy|__bypass|__patch|puppeteer_|playwright_|selenium_|webdriver_|cdc_|_phantom$|callPhantom$)/;

/** Check window globals for known bot-injected patterns. */
function checkClientLitter(): string[] {
  try {
    const matches: string[] = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      if (BOT_LITTER_RE.test(key)) matches.push(key);
    }
    return matches;
  } catch {
    return [];
  }
}

export function normalizeStrokes(
  strokes: Stroke[],
  startTime: number,
  canvasSize: number = 280
): NormalizedStroke[] {
  return strokes.map((s) => ({
    points: s.points.map((p) => ({
      x: p.x / canvasSize,
      y: p.y / canvasSize,
      t: p.t - startTime,
      pressure: p.pressure,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      width: p.width,
      height: p.height,
      coalescedCount: p.coalescedCount,
      coalescedSpoofed: p.coalescedSpoofed,
      movementX: p.movementX,
      movementY: p.movementY,
      predictedCount: p.predictedCount,
      timestampDelta: p.timestampDelta,
    })),
    startTime: s.startTime - startTime,
    endTime: s.endTime - startTime,
  }));
}
