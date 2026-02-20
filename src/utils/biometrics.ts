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

export function computeFeatures(strokes: Stroke[]) {
  const allPoints: StrokePoint[] = strokes.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return {
      strokeCount: strokes.length,
      totalPoints: allPoints.length,
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
      rafCadenceRatio: 0,
      velocityBellScore: 0,
      interStrokePauseCV: 0,
      coalescedSupported: COALESCED_SUPPORTED,
    };
  }

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

  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const variance = (a: number[]) => {
    const m = avg(a);
    return a.length ? a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length : 0;
  };

  const pressures = allPoints.map((p) => p.pressure);
  const widths = allPoints.map((p) => p.width);
  const heights = allPoints.map((p) => p.height);
  const strokeGaps: number[] = [];
  for (let i = 1; i < strokes.length; i++) {
    strokeGaps.push(strokes[i].startTime - strokes[i - 1].endTime);
  }
  const totalTime = allPoints[allPoints.length - 1].t - allPoints[0].t;

  // Coalesced event ratio: fraction of move events with coalesced count > 0.
  // Real browsers coalesce 2-6 pointer events per frame dispatch; automation
  // frameworks (Playwright, Puppeteer) always produce 0 coalesced events.
  const movePoints = allPoints.slice(1); // skip first point (pointerdown)
  const coalescedMoves = movePoints.filter((p) => p.coalescedCount > 0).length;
  const coalescedRatio = movePoints.length > 0 ? coalescedMoves / movePoints.length : 0;

  // ── rAF cadence ratio ──
  // Real pointer events are dispatched during rAF processing, so inter-point
  // deltas cluster tightly around multiples of the display's frame period.
  // CDP-injected events (Playwright) arrive at arbitrary times — no clustering.
  // Check against common refresh rates: 60Hz, 90Hz, 120Hz, 144Hz.
  const FRAME_PERIODS = [16.667, 11.111, 8.333, 6.944]; // 60, 90, 120, 144 Hz
  const TOLERANCE_MS = 2.5;
  const dts: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt > 0) dts.push(dt);
    }
  }
  // For each frame period, count how many deltas are on-grid; take the best
  let rafCadenceRatio = 0;
  if (dts.length > 0) {
    for (const framePeriod of FRAME_PERIODS) {
      let onGrid = 0;
      for (const dt of dts) {
        const remainder = dt % framePeriod;
        if (remainder < TOLERANCE_MS || framePeriod - remainder < TOLERANCE_MS) {
          onGrid++;
        }
      }
      rafCadenceRatio = Math.max(rafCadenceRatio, onGrid / dts.length);
    }
  }

  // ── Velocity bell score ──
  // Human strokes follow the "minimum jerk" principle: slow-fast-slow velocity
  // profile (bell-shaped). We compare each stroke's velocity profile against
  // sin(π * progress) and average the fit across all strokes.
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
  const velocityBellScore = bellCount > 0 ? bellScoreSum / bellCount : 0;

  // ── Inter-stroke pause CV ──
  // Humans have bimodal pauses: short within characters (~50-200ms), long
  // between characters (~300-2000ms) → high CV. Bots drawing from a single
  // distribution (e.g., logNormal(90, 0.4)) produce uniform-ish pauses → low CV.
  const gapAvg = avg(strokeGaps);
  const gapStddev = Math.sqrt(variance(strokeGaps));
  const interStrokePauseCV = gapAvg > 0 ? gapStddev / gapAvg : 0;

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
    coalescedRatio,
    rafCadenceRatio,
    velocityBellScore,
    interStrokePauseCV,
    coalescedSupported: COALESCED_SUPPORTED,
  };
}

// ── Prototype tamper detection ──────────────────────────────────────
// Lightweight checks inspired by ms-argus-web's lies module.
// Tests APIs we rely on for bot detection (coalescedEvents, etc.).
// If any are tampered with (toString, descriptor, etc.), flag it.

const NATIVE_RE = /\{\s*\[native code\]\s*\}/;

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

  return tampered;
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
    iframe.style.cssText = 'display:none;width:0;height:0;border:none';
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

/** Detect CDP usage, automation globals, and headless artifacts. */
export function detectCDP(): string[] {
  const signals: string[] = [];

  // 1. navigator.webdriver — standard automation flag
  try {
    if ((navigator as unknown as Record<string, unknown>).webdriver === true) {
      signals.push('cdp:webdriver');
    }
  } catch {
    /* ignore */
  }

  // 2. ChromeDriver globals — cdc_ prefixed properties on document
  try {
    for (const key of Object.getOwnPropertyNames(document)) {
      if (/^(\$)?cdc_/.test(key)) {
        signals.push('cdp:cdc_global');
        break;
      }
    }
  } catch {
    /* ignore */
  }

  // 3. Playwright / Puppeteer / PhantomJS / Nightmare / Selenium globals
  const globalChecks: [string, () => unknown][] = [
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
  // Also check __pw_* pattern (Playwright internal bindings)
  try {
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^__pw_/.test(key)) {
        signals.push('cdp:pw_binding');
        break;
      }
    }
  } catch {
    /* ignore */
  }

  for (const [name, getFn] of globalChecks) {
    try {
      if (getFn() != null) {
        signals.push(`cdp:${name}`);
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Phantom iframe comparison — stealth plugin detection
  // Stealth JS plugins patch navigator.webdriver on the main frame only.
  // An iframe in a closed shadow DOM won't get those patches.
  try {
    const mainWebdriver = (navigator as unknown as Record<string, unknown>).webdriver;
    const phantom = getPhantomWindow();
    if (phantom) {
      const iframeWebdriver = (phantom.navigator as unknown as Record<string, unknown>).webdriver;
      // Main says undefined/false but iframe says true → JS-level spoofing
      if (!mainWebdriver && iframeWebdriver === true) {
        signals.push('cdp:phantom_mismatch');
      }
    }
  } catch {
    /* ignore */
  }

  // 5. WebGL renderer — SwiftShader indicates headless Chrome
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl && gl instanceof WebGLRenderingContext) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
        if (/swiftshader/i.test(renderer)) {
          signals.push('cdp:swiftshader');
        }
      }
    }
  } catch {
    /* ignore */
  }

  return signals;
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
    })),
    startTime: s.startTime - startTime,
    endTime: s.endTime - startTime,
  }));
}
