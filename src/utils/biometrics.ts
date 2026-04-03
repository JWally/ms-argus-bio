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
    rawUpdateCount: number;
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
  score?: number;
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

// ── Math helpers for motor-control features ─────────────────────────

/** Linear regression: returns slope (β) and coefficient of determination (R²) */
function linearRegression(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = avg(xs),
    my = avg(ys);
  let ssxy = 0,
    ssxx = 0,
    ssyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx,
      dy = ys[i] - my;
    ssxy += dx * dy;
    ssxx += dx * dx;
    ssyy += dy * dy;
  }
  const slope = ssxx > 0 ? ssxy / ssxx : 0;
  const r2 = ssxx > 0 && ssyy > 0 ? (ssxy * ssxy) / (ssxx * ssyy) : 0;
  return { slope, r2 };
}

/** Pearson correlation coefficient between two arrays */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = avg(xs.slice(0, n)),
    my = avg(ys.slice(0, n));
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx,
      dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 0 ? sxy / denom : 0;
}

/** Spectral power at a specific frequency for a uniformly-sampled signal */
function spectralPowerAt(signal: number[], freqHz: number, sampleRateHz: number): number {
  const N = signal.length;
  if (N === 0) return 0;
  let re = 0,
    im = 0;
  for (let n = 0; n < N; n++) {
    const phase = (2 * Math.PI * freqHz * n) / sampleRateHz;
    re += signal[n] * Math.cos(phase);
    im -= signal[n] * Math.sin(phase);
  }
  return (re * re + im * im) / (N * N);
}

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

// ── Motor-control feature computations ──────────────────────────────

/** Speed-curvature power law: V = k × R^β (2/3 power law of movement).
 *  Human motor control produces β ≈ 0.28-0.38. Bots with independent timing: β ≈ 0-0.15.
 *  Returns per-stroke betas, overall beta, R², and variance. */
function computePowerLaw(strokes: Stroke[]): { beta: number; r2: number; betaVar: number } {
  const allLogV: number[] = [];
  const allLogR: number[] = [];
  const perStrokeBetas: number[] = [];

  for (const stroke of strokes) {
    const pts = stroke.points;
    const strokeLogV: number[] = [];
    const strokeLogR: number[] = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const dt = pts[i + 1].t - pts[i].t;
      if (dt < 1) continue;
      const dx1 = pts[i].x - pts[i - 1].x,
        dy1 = pts[i].y - pts[i - 1].y;
      const dx2 = pts[i + 1].x - pts[i].x,
        dy2 = pts[i + 1].y - pts[i].y;
      const speed = Math.sqrt(dx2 * dx2 + dy2 * dy2) / dt;
      const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (l1 < 0.5 || l2 < 0.5 || speed < 0.01) continue;
      const curvature = cross / (l1 * l2);
      if (curvature > 0.001) {
        const lv = Math.log(speed);
        const lr = Math.log(1 / curvature);
        strokeLogV.push(lv);
        strokeLogR.push(lr);
        allLogV.push(lv);
        allLogR.push(lr);
      }
    }
    if (strokeLogV.length >= 3) {
      perStrokeBetas.push(linearRegression(strokeLogR, strokeLogV).slope);
    }
  }

  const overall = linearRegression(allLogR, allLogV);
  return {
    beta: overall.slope,
    r2: overall.r2,
    betaVar: variance(perStrokeBetas),
  };
}

function collectSpeedSamples(strokes: Stroke[]): { t: number; v: number }[] {
  const samples: { t: number; v: number }[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) continue;
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      samples.push({ t: stroke.points[i].t, v: Math.sqrt(dx * dx + dy * dy) / dt });
    }
  }
  return samples;
}

/** Tremor spectral ratio: power in 8-12 Hz / total power (1-20 Hz).
 *  Human physiological tremor peaks at 8-12 Hz.
 *  Bot Gaussian noise has flat spectrum. */
function computeTremorRatio(strokes: Stroke[]): number {
  const samples = collectSpeedSamples(strokes);
  if (samples.length < 20) return 0;

  // Resample to uniform 100 Hz via linear interpolation
  const SAMPLE_RATE = 100;
  const tStart = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  const duration = tEnd - tStart;
  if (duration < 100) return 0; // need at least 100ms
  const uniformCount = Math.min(Math.floor((duration / 1000) * SAMPLE_RATE), 512);
  if (uniformCount < 20) return 0;
  const uniform: number[] = [];
  let si = 0;
  for (let i = 0; i < uniformCount; i++) {
    const t = tStart + (i * 1000) / SAMPLE_RATE;
    while (si < samples.length - 1 && samples[si + 1].t < t) si++;
    if (si >= samples.length - 1) {
      uniform.push(samples[samples.length - 1].v);
    } else {
      const frac = (t - samples[si].t) / (samples[si + 1].t - samples[si].t);
      uniform.push(samples[si].v * (1 - frac) + samples[si + 1].v * frac);
    }
  }

  // Remove mean (DC component)
  const mean = avg(uniform);
  const centered = uniform.map((v) => v - mean);

  // Compute spectral power at 1-20 Hz
  let totalPower = 0;
  let tremorPower = 0;
  for (let f = 1; f <= 20; f++) {
    const p = spectralPowerAt(centered, f, SAMPLE_RATE);
    totalPower += p;
    if (f >= 8 && f <= 12) tremorPower += p;
  }
  return totalPower > 0 ? tremorPower / totalPower : 0;
}

/** Pressure-velocity anti-correlation.
 *  Humans press harder in curves (slow) and lighter on straight segments (fast) → r ≈ -0.3 to -0.6.
 *  Bots have no pressure-velocity coupling → r ≈ 0. */
function computePressureVelocityR(strokes: Stroke[]): number {
  const pressures: number[] = [];
  const speeds: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) continue;
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
      pressures.push(stroke.points[i].pressure);
    }
  }
  return pearsonCorrelation(pressures, speeds);
}

/** Velocity autocorrelation at lags 1, 2, 3.
 *  Human movements are temporally smooth (lag-1 r ≈ 0.5-0.8).
 *  Bot IID timing produces near-zero autocorrelation. */
function computeVelocityAutocorrelation(strokes: Stroke[]): [number, number, number] {
  const speeds: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) continue;
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
    }
  }
  if (speeds.length < 6) return [0, 0, 0];
  const mean = avg(speeds);
  const denom = speeds.reduce((s, v) => s + (v - mean) ** 2, 0);
  if (denom === 0) return [0, 0, 0];
  const result: [number, number, number] = [0, 0, 0];
  for (let lag = 1; lag <= 3; lag++) {
    let num = 0;
    for (let i = 0; i < speeds.length - lag; i++) {
      num += (speeds[i] - mean) * (speeds[i + lag] - mean);
    }
    result[lag - 1] = num / denom;
  }
  return result;
}

/** Ballistic onset: normalized position of peak speed within each stroke.
 *  Humans peak early (0.15-0.30). Bots peak anywhere (~0.4-0.6). */
function computeBallisticOnset(strokes: Stroke[]): number {
  const peaks: number[] = [];
  for (const stroke of strokes) {
    if (stroke.points.length < 5) continue;
    let maxSpeed = 0,
      maxIdx = 0;
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) continue;
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      const speed = Math.sqrt(dx * dx + dy * dy) / dt;
      if (speed > maxSpeed) {
        maxSpeed = speed;
        maxIdx = i;
      }
    }
    if (maxSpeed > 0) peaks.push(maxIdx / stroke.points.length);
  }
  return avg(peaks);
}

/** Log dimensionless jerk — standard smoothness metric (Balasubramanian 2012).
 *  LDLJ = log(√(∫jerk²dt × T⁵ / L²)). Lower = smoother = more human. */
function computeLogDimensionlessJerk(strokes: Stroke[]): number {
  let totalJerkSq = 0,
    totalPathLen = 0,
    totalDuration = 0;
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < 4) continue;
    const T = pts[pts.length - 1].t - pts[0].t;
    if (T < 10) continue;

    let pathLen = 0;
    const speeds: { s: number; t: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x,
        dy = pts[i].y - pts[i - 1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      pathLen += dist;
      const dt = pts[i].t - pts[i - 1].t;
      if (dt > 0) speeds.push({ s: dist / dt, t: pts[i].t });
    }
    if (pathLen < 1 || speeds.length < 3) continue;

    // Compute jerk² integral (finite differences)
    let jerkSqInt = 0;
    for (let i = 1; i < speeds.length - 1; i++) {
      const dt1 = speeds[i].t - speeds[i - 1].t;
      const dt2 = speeds[i + 1].t - speeds[i].t;
      if (dt1 < 1 || dt2 < 1) continue;
      const a1 = (speeds[i].s - speeds[i - 1].s) / dt1;
      const a2 = (speeds[i + 1].s - speeds[i].s) / dt2;
      const dtAvg = (dt1 + dt2) / 2;
      const jerk = (a2 - a1) / dtAvg;
      jerkSqInt += jerk * jerk * dtAvg;
    }

    totalJerkSq += jerkSqInt;
    totalPathLen += pathLen;
    totalDuration += T;
  }
  if (totalPathLen < 1 || totalDuration < 10) return 0;
  const dimensionless = (totalJerkSq * Math.pow(totalDuration, 5)) / (totalPathLen * totalPathLen);
  return Math.log(Math.sqrt(dimensionless) + 1);
}

/** Sub-stroke count: average velocity peaks per stroke.
 *  Humans produce 2-4 sub-movements. Bots produce 0-1 or noisy 5+. */
function computeSubStrokeCount(strokes: Stroke[]): number {
  let totalPeaks = 0,
    strokeCount = 0;
  for (const stroke of strokes) {
    if (stroke.points.length < 5) continue;
    // Compute smoothed speed profile
    const speeds: number[] = [];
    for (let i = 1; i < stroke.points.length; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) {
        speeds.push(0);
        continue;
      }
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
    }
    // Moving average (window 3)
    const smoothed: number[] = [];
    for (let i = 0; i < speeds.length; i++) {
      const lo = Math.max(0, i - 1),
        hi = Math.min(speeds.length - 1, i + 1);
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += speeds[j];
      smoothed.push(sum / (hi - lo + 1));
    }
    // Count local maxima
    let peaks = 0;
    for (let i = 1; i < smoothed.length - 1; i++) {
      if (smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) peaks++;
    }
    totalPeaks += peaks;
    strokeCount++;
  }
  return strokeCount > 0 ? totalPeaks / strokeCount : 0;
}

/** Direction angle entropy: Shannon entropy of movement direction histogram (16 bins).
 *  Humans have directional preferences. Bots with Gaussian noise are more uniform. */
function computeDirectionEntropy(strokes: Stroke[]): number {
  const BINS = 16;
  const bins = new Array(BINS).fill(0);
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
      let angle = Math.atan2(dy, dx); // -PI to PI
      if (angle < 0) angle += 2 * Math.PI; // 0 to 2PI
      const bin = Math.min(BINS - 1, Math.floor((angle / (2 * Math.PI)) * BINS));
      bins[bin]++;
      total++;
    }
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of bins) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/** Endpoint precision ratio: position variance at stroke endpoints vs midstroke.
 *  Humans are precise at endpoints. Bots have uniform noise. */
function computeEndpointPrecisionRatio(strokes: Stroke[]): number {
  const endpointSpeeds: number[] = [];
  const midSpeeds: number[] = [];
  for (const stroke of strokes) {
    if (stroke.points.length < 10) continue;
    const n = stroke.points.length;
    const threshold = Math.max(1, Math.floor(n * 0.15));
    for (let i = 1; i < n; i++) {
      const dt = stroke.points[i].t - stroke.points[i - 1].t;
      if (dt < 1) continue;
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      const speed = Math.sqrt(dx * dx + dy * dy) / dt;
      if (i < threshold || i >= n - threshold) {
        endpointSpeeds.push(speed);
      } else {
        midSpeeds.push(speed);
      }
    }
  }
  const endVar = variance(endpointSpeeds);
  const midVar = variance(midSpeeds);
  return midVar > 0 ? endVar / midVar : 0;
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
  // Motor-control features
  powerLawBeta: 0,
  powerLawR2: 0,
  powerLawBetaVar: 0,
  tremorRatio: 0,
  pressureVelocityR: 0,
  velocityAutoCorr1: 0,
  velocityAutoCorr2: 0,
  velocityAutoCorr3: 0,
  ballisticOnset: 0,
  logDimensionlessJerk: 0,
  subStrokeCount: 0,
  directionEntropy: 0,
  endpointPrecisionRatio: 0,
  contactAreaDynamics: 0,
  avgRawUpdateCount: 0,
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

  // ── Motor-control features ──
  const powerLaw = computePowerLaw(strokes);
  const [velocityAutoCorr1, velocityAutoCorr2, velocityAutoCorr3] =
    computeVelocityAutocorrelation(strokes);
  const contactAreas = allPoints.map((p) => p.width * p.height);
  const avgRawUpdateCount = avg(movePoints.map((p) => p.rawUpdateCount));

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
    // Motor-control features
    powerLawBeta: powerLaw.beta,
    powerLawR2: powerLaw.r2,
    powerLawBetaVar: powerLaw.betaVar,
    tremorRatio: computeTremorRatio(strokes),
    pressureVelocityR: computePressureVelocityR(strokes),
    velocityAutoCorr1,
    velocityAutoCorr2,
    velocityAutoCorr3,
    ballisticOnset: computeBallisticOnset(strokes),
    logDimensionlessJerk: computeLogDimensionlessJerk(strokes),
    subStrokeCount: computeSubStrokeCount(strokes),
    directionEntropy: computeDirectionEntropy(strokes),
    endpointPrecisionRatio: computeEndpointPrecisionRatio(strokes),
    contactAreaDynamics: variance(contactAreas),
    avgRawUpdateCount,
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
      rawUpdateCount: p.rawUpdateCount,
    })),
    startTime: s.startTime - startTime,
    endTime: s.endTime - startTime,
  }));
}
