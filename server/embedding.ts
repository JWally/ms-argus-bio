// server/embedding.ts
// BiometricPayload → 64d vector encoding

import type { BiometricPayload, NormalizedStroke } from "./types";

const EMBEDDING_DIMS = 64;

/** Clamp value to [0, 1] after min-max normalization */
function norm(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Compute per-digit stroke shape features (5 per digit) */
function digitShapeFeatures(strokes: NormalizedStroke[]): number[] {
  if (strokes.length === 0 || strokes.every((s) => s.points.length < 2)) {
    return [0, 0, 0, 0, 0];
  }

  const allPoints = strokes.flatMap((s) => s.points);

  // Average curvature: angle changes between consecutive point triplets
  let totalCurvature = 0;
  let curvatureCount = 0;
  let directionChanges = 0;

  for (const stroke of strokes) {
    for (let i = 2; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 2];
      const p1 = stroke.points[i - 1];
      const p2 = stroke.points[i];
      const dx1 = p1.x - p0.x;
      const dy1 = p1.y - p0.y;
      const dx2 = p2.x - p1.x;
      const dy2 = p2.y - p1.y;
      const cross = dx1 * dy2 - dy1 * dx2;
      const dot = dx1 * dx2 + dy1 * dy2;
      const angle = Math.abs(Math.atan2(cross, dot));
      totalCurvature += angle;
      curvatureCount++;
      if (i >= 3) {
        const prevDx = stroke.points[i - 2].x - stroke.points[i - 3].x;
        const prevDy = stroke.points[i - 2].y - stroke.points[i - 3].y;
        const prevSign = Math.sign(prevDx * dy1 - prevDy * dx1);
        const currSign = Math.sign(dx1 * dy2 - dy1 * dx2);
        if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
          directionChanges++;
        }
      }
    }
  }

  const avgCurvature = curvatureCount > 0 ? totalCurvature / curvatureCount : 0;

  // Bounding box aspect ratio and coverage
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const aspectRatio = bboxH > 0 ? bboxW / bboxH : 1;

  // Coverage: total stroke length relative to bbox diagonal
  let totalLength = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const dx = stroke.points[i].x - stroke.points[i - 1].x;
      const dy = stroke.points[i].y - stroke.points[i - 1].y;
      totalLength += Math.sqrt(dx * dx + dy * dy);
    }
  }
  const diagonal = Math.sqrt(bboxW * bboxW + bboxH * bboxH);
  const coverageRatio = diagonal > 0 ? totalLength / diagonal : 0;

  // Stroke length variance
  const strokeLengths = strokes.map((s) => {
    let len = 0;
    for (let i = 1; i < s.points.length; i++) {
      const dx = s.points[i].x - s.points[i - 1].x;
      const dy = s.points[i].y - s.points[i - 1].y;
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return len;
  });
  const avgLen =
    strokeLengths.length > 0
      ? strokeLengths.reduce((a, b) => a + b, 0) / strokeLengths.length
      : 0;
  const strokeLengthVariance =
    strokeLengths.length > 0
      ? strokeLengths.reduce((s, v) => s + (v - avgLen) ** 2, 0) /
        strokeLengths.length
      : 0;

  return [avgCurvature, directionChanges, aspectRatio, coverageRatio, strokeLengthVariance];
}

/**
 * Encode a BiometricPayload into a 64-dimensional feature vector.
 * All features are min-max normalized to [0, 1].
 */
export function encode(payload: BiometricPayload): number[] {
  const f = payload.features;
  const vec: number[] = [];

  // ── Dims 0-12: Aggregate features (13d) ──
  vec.push(norm(f.strokeCount, 0, 50));
  vec.push(norm(f.totalPoints, 0, 5000));
  vec.push(norm(f.avgSpeed, 0, 2));
  vec.push(norm(f.speedVariance, 0, 1));
  vec.push(norm(f.maxSpeed, 0, 5));
  vec.push(norm(f.avgPressure, 0, 1));
  vec.push(norm(f.pressureVariance, 0, 0.25));
  vec.push(norm(f.avgContactWidth, 0, 50));
  vec.push(norm(f.avgContactHeight, 0, 50));
  vec.push(norm(f.totalDurationMs, 0, 45000));
  vec.push(norm(f.avgTimeBetweenStrokes, 0, 5000));
  vec.push(norm(f.eventFrequencyHz, 0, 200));
  vec.push(norm(f.avgJerk, 0, 0.1));

  // ── Dims 13-27: Per-digit features (15d = 5 per digit × 3 digits) ──
  for (let i = 0; i < 3; i++) {
    const d = payload.digits[i];
    if (d) {
      vec.push(norm(d.confidence, 0, 1));
      vec.push(norm(d.timeMs, 0, 20000));
      vec.push(norm(d.strokes.length, 0, 15));
      vec.push(
        norm(
          d.strokes.reduce((s, st) => s + st.points.length, 0),
          0,
          2000,
        ),
      );
      // Per-digit avg speed
      let digitSpeed = 0;
      let speedCount = 0;
      for (const stroke of d.strokes) {
        for (let j = 1; j < stroke.points.length; j++) {
          const p0 = stroke.points[j - 1];
          const p1 = stroke.points[j];
          const dt = p1.t - p0.t;
          if (dt > 0) {
            digitSpeed +=
              Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt;
            speedCount++;
          }
        }
      }
      vec.push(norm(speedCount > 0 ? digitSpeed / speedCount : 0, 0, 2));
    } else {
      vec.push(0, 0, 0, 0, 0);
    }
  }

  // ── Dims 28-32: Timing features (5d) ──
  const digitTimes = payload.digits.map((d) => d.timeMs);
  const avgDigitTime =
    digitTimes.length > 0
      ? digitTimes.reduce((a, b) => a + b, 0) / digitTimes.length
      : 0;
  const timeVariance =
    digitTimes.length > 0
      ? digitTimes.reduce((s, v) => s + (v - avgDigitTime) ** 2, 0) /
        digitTimes.length
      : 0;
  const fastestDigitRatio =
    avgDigitTime > 0 ? Math.min(...digitTimes) / avgDigitTime : 0;

  vec.push(norm(payload.completionTimeMs, 0, 45000));
  vec.push(payload.passed ? 1 : 0);
  vec.push(norm(avgDigitTime, 0, 15000));
  vec.push(norm(timeVariance, 0, 50000000));
  vec.push(norm(fastestDigitRatio, 0, 1));

  // ── Dims 33-37: Confidence ramp features (5d) ──
  const timeline = payload.confidenceTimeline;
  const rampRates: number[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const dt = timeline[i].t - timeline[i - 1].t;
    if (dt > 0 && timeline[i].digitIndex === timeline[i - 1].digitIndex) {
      rampRates.push(
        (timeline[i].targetConf - timeline[i - 1].targetConf) / dt,
      );
    }
  }
  const avgRampRate =
    rampRates.length > 0
      ? rampRates.reduce((a, b) => a + b, 0) / rampRates.length
      : 0;
  const finalConf =
    timeline.length > 0 ? timeline[timeline.length - 1].targetConf : 0;
  const confValues = timeline.map((s) => s.targetConf);
  const avgConf =
    confValues.length > 0
      ? confValues.reduce((a, b) => a + b, 0) / confValues.length
      : 0;
  const confVariance =
    confValues.length > 0
      ? confValues.reduce((s, v) => s + (v - avgConf) ** 2, 0) /
        confValues.length
      : 0;
  const firstHighConf = timeline.find((s) => s.targetConf >= 0.9);
  const timeToFirstHighConf = firstHighConf ? firstHighConf.t : 45000;

  vec.push(norm(avgRampRate, -0.01, 0.01));
  vec.push(norm(finalConf, 0, 1));
  vec.push(norm(timeline.length, 0, 200));
  vec.push(norm(confVariance, 0, 0.25));
  vec.push(norm(timeToFirstHighConf, 0, 45000));

  // ── Dims 38-42: Temporal features (5d) ──
  const allStrokes = payload.digits.flatMap((d) => d.strokes);
  const allPoints = allStrokes.flatMap((s) => s.points);

  // Pause ratio: time between strokes / total time
  let totalPauseTime = 0;
  for (let i = 1; i < allStrokes.length; i++) {
    const gap = allStrokes[i].startTime - allStrokes[i - 1].endTime;
    if (gap > 0) totalPauseTime += gap;
  }
  const totalTime =
    allPoints.length >= 2
      ? allPoints[allPoints.length - 1].t - allPoints[0].t
      : 1;
  const pauseRatio = totalTime > 0 ? totalPauseTime / totalTime : 0;

  // Speed acceleration pattern: ratio of speed in first half vs second half
  const speeds: number[] = [];
  for (const stroke of allStrokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 1];
      const p1 = stroke.points[i];
      const dt = p1.t - p0.t;
      if (dt > 0) {
        speeds.push(
          Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt,
        );
      }
    }
  }
  const half = Math.floor(speeds.length / 2);
  const firstHalfAvg =
    half > 0
      ? speeds.slice(0, half).reduce((a, b) => a + b, 0) / half
      : 0;
  const secondHalfAvg =
    speeds.length - half > 0
      ? speeds.slice(half).reduce((a, b) => a + b, 0) / (speeds.length - half)
      : 0;
  const speedAccelPattern =
    firstHalfAvg > 0 ? secondHalfAvg / firstHalfAvg : 1;

  // Rhythm consistency: variance of inter-stroke intervals
  const intervals: number[] = [];
  for (let i = 1; i < allStrokes.length; i++) {
    intervals.push(allStrokes[i].startTime - allStrokes[i - 1].endTime);
  }
  const avgInterval =
    intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 0;
  const rhythmConsistency =
    intervals.length > 0
      ? Math.sqrt(
          intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) /
            intervals.length,
        )
      : 0;

  // Timing entropy: Shannon entropy of time intervals binned into 10 bins
  let timingEntropy = 0;
  if (intervals.length > 1) {
    const maxInt = Math.max(...intervals);
    const minInt = Math.min(...intervals);
    const binCount = 10;
    const bins = new Array(binCount).fill(0);
    for (const iv of intervals) {
      const bin =
        maxInt === minInt
          ? 0
          : Math.min(
              binCount - 1,
              Math.floor(((iv - minInt) / (maxInt - minInt)) * binCount),
            );
      bins[bin]++;
    }
    for (const count of bins) {
      if (count > 0) {
        const p = count / intervals.length;
        timingEntropy -= p * Math.log2(p);
      }
    }
  }

  // Stroke overlap: fraction of strokes that temporally overlap
  let overlaps = 0;
  for (let i = 1; i < allStrokes.length; i++) {
    if (allStrokes[i].startTime < allStrokes[i - 1].endTime) {
      overlaps++;
    }
  }
  const strokeOverlap =
    allStrokes.length > 1 ? overlaps / (allStrokes.length - 1) : 0;

  vec.push(norm(pauseRatio, 0, 1));
  vec.push(norm(speedAccelPattern, 0, 3));
  vec.push(norm(rhythmConsistency, 0, 2000));
  vec.push(norm(timingEntropy, 0, Math.log2(10)));
  vec.push(norm(strokeOverlap, 0, 1));

  // ── Dims 43-57: Stroke shape features (15d = 5 per digit × 3 digits) ──
  for (let i = 0; i < 3; i++) {
    const d = payload.digits[i];
    if (d) {
      const shape = digitShapeFeatures(d.strokes);
      vec.push(norm(shape[0], 0, Math.PI)); // avgCurvature
      vec.push(norm(shape[1], 0, 50)); // directionChanges
      vec.push(norm(shape[2], 0, 3)); // aspectRatio
      vec.push(norm(shape[3], 0, 20)); // coverageRatio
      vec.push(norm(shape[4], 0, 0.1)); // strokeLengthVariance
    } else {
      vec.push(0, 0, 0, 0, 0);
    }
  }

  // ── Dims 58-63: Device features (6d) ──
  // Input type one-hot (3d): mouse, touch, pen
  vec.push(payload.inputType === "mouse" ? 1 : 0);
  vec.push(payload.inputType === "touch" ? 1 : 0);
  vec.push(payload.inputType === "pen" ? 1 : 0);
  vec.push(norm(payload.screenWidth, 0, 3840));
  vec.push(norm(payload.screenHeight, 0, 2160));
  vec.push(norm(payload.devicePixelRatio, 1, 4));

  // Sanity check
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, got ${vec.length}`,
    );
  }

  return vec;
}

export const EMBEDDING_VERSION = "v1";
export { EMBEDDING_DIMS };
