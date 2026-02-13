// server/heuristics.ts
// Auto-labeling rules for human/bot/uncertain classification

import type { BiometricPayload, Label } from './types';

/**
 * Count the ratio of consecutive point pairs with near-zero time delta.
 * Real browser pointer events are dispatched at most once per frame (~8-16ms).
 * Synthetic dispatchEvent() in a loop produces many points at dt ≈ 0ms.
 */
function zeroDtRatio(payload: BiometricPayload): number {
  let zeroDtCount = 0;
  let pairCount = 0;
  for (const digit of payload.digits) {
    for (const stroke of digit.strokes) {
      for (let i = 1; i < stroke.points.length; i++) {
        pairCount++;
        if (stroke.points[i].t - stroke.points[i - 1].t < 1) {
          zeroDtCount++;
        }
      }
    }
  }
  return pairCount > 0 ? zeroDtCount / pairCount : 0;
}

/**
 * Coefficient of variation of inter-point time deltas.
 * Real human pointer events have irregular timing (CV > 0.5) due to
 * natural motor variation. Playwright's page.mouse.move({steps: N})
 * produces metronomic timing (CV < 0.3) because intermediate points
 * are evenly spaced with uniform waitForTimeout delays.
 */
export function timingCV(payload: BiometricPayload): number {
  const dts: number[] = [];
  for (const digit of payload.digits) {
    for (const stroke of digit.strokes) {
      for (let i = 1; i < stroke.points.length; i++) {
        const dt = stroke.points[i].t - stroke.points[i - 1].t;
        if (dt > 0) dts.push(dt);
      }
    }
  }
  if (dts.length < 2) return 999; // Not enough data — don't flag
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  if (avg === 0) return 0;
  const stddev = Math.sqrt(dts.reduce((s, v) => s + (v - avg) ** 2, 0) / dts.length);
  return stddev / avg;
}

/**
 * Apply heuristic rules to auto-label a biometric payload.
 *
 * Bot signals (any one → bot):
 * - completionTimeMs < 500 (impossibly fast for 3 digits)
 * - eventFrequencyHz > 300 (synthetic event injection)
 * - speedVariance === 0 with totalPoints > 20 (perfectly uniform movement)
 * - >20% of consecutive point pairs have dt < 1ms (dispatchEvent batching)
 * - timingCV < 0.3 with totalPoints > 20 (metronomic timing from automation)
 *
 * Human signals (all must hold → human):
 * - passed === true (recognized all digits)
 * - speedVariance > 0 (some natural variation)
 * - 1000 < completionTimeMs < 45000
 * - strokeCount >= 3 (at least one stroke per digit)
 * - totalPoints > 10 (enough data to be real drawing)
 * - eventFrequencyHz between 10-200Hz (sanity min; Firefox/Linux can be ~15-30Hz)
 */
function isBotSignal(payload: BiometricPayload): boolean {
  const f = payload.features;
  if (payload.completionTimeMs < 500) return true;
  if (f.eventFrequencyHz > 300) return true;
  if (f.speedVariance === 0 && f.totalPoints > 20) return true;
  // Synthetic event batching or metronomic timing (enough points to be reliable)
  if (f.totalPoints > 20 && (zeroDtRatio(payload) > 0.2 || timingCV(payload) < 0.3)) return true;
  return false;
}

function isHumanSignal(payload: BiometricPayload): boolean {
  const f = payload.features;
  return (
    payload.passed === true &&
    f.speedVariance > 0 &&
    payload.completionTimeMs > 1000 &&
    payload.completionTimeMs < 45000 &&
    f.strokeCount >= 3 &&
    f.totalPoints > 10 &&
    f.eventFrequencyHz >= 10 &&
    f.eventFrequencyHz <= 200
  );
}

export function heuristicLabel(payload: BiometricPayload): Label {
  if (isBotSignal(payload)) return 'bot';
  if (isHumanSignal(payload)) return 'human';
  return 'uncertain';
}
