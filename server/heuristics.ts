// server/heuristics.ts
// Auto-labeling rules for human/bot/uncertain classification

import type { BiometricPayload, Label } from "./types";

/**
 * Apply heuristic rules to auto-label a biometric payload.
 *
 * Bot signals (any one → bot):
 * - avgPressure === 0 && pressureVariance === 0 on non-mouse input
 * - speedVariance < 0.001 (machine-perfect uniformity)
 * - completionTimeMs < 800 (impossibly fast)
 * - eventFrequencyHz > 200 (synthetic event rate)
 * - avgJerk === 0 (no human tremor)
 *
 * Human signals (all must hold → human):
 * - passed === true
 * - speedVariance > 0.01
 * - 1500 < completionTimeMs < 30000
 * - 20 < eventFrequencyHz < 150
 * - avgJerk > 0
 * - 3 <= strokeCount <= 25
 */
export function heuristicLabel(payload: BiometricPayload): Label {
  const f = payload.features;

  // ── Bot signals (any one triggers) ──
  if (
    f.avgPressure === 0 &&
    f.pressureVariance === 0 &&
    payload.inputType !== "mouse"
  ) {
    return "bot";
  }
  if (f.speedVariance < 0.001) return "bot";
  if (payload.completionTimeMs < 800) return "bot";
  if (f.eventFrequencyHz > 200) return "bot";
  if (f.avgJerk === 0) return "bot";

  // ── Human signals (all must hold) ──
  if (
    payload.passed === true &&
    f.speedVariance > 0.01 &&
    payload.completionTimeMs > 1500 &&
    payload.completionTimeMs < 30000 &&
    f.eventFrequencyHz > 20 &&
    f.eventFrequencyHz < 150 &&
    f.avgJerk > 0 &&
    f.strokeCount >= 3 &&
    f.strokeCount <= 25
  ) {
    return "human";
  }

  return "uncertain";
}
