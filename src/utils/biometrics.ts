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
  };
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
    })),
    startTime: s.startTime - startTime,
    endTime: s.endTime - startTime,
  }));
}
