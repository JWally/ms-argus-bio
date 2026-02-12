// server/heuristics.ts
// Auto-labeling rules for human/bot/uncertain classification

import type { BiometricPayload, Label } from "./types";

/**
 * Apply heuristic rules to auto-label a biometric payload.
 *
 * Bot signals (any one → bot):
 * - completionTimeMs < 500 (impossibly fast for 3 digits)
 * - eventFrequencyHz > 300 (synthetic event injection)
 * - speedVariance === 0 with totalPoints > 20 (perfectly uniform movement)
 *
 * Human signals (all must hold → human):
 * - passed === true (recognized all digits)
 * - speedVariance > 0 (some natural variation)
 * - 1000 < completionTimeMs < 45000
 * - strokeCount >= 3 (at least one stroke per digit)
 * - totalPoints > 10 (enough data to be real drawing)
 */
export function heuristicLabel(payload: BiometricPayload): Label {
  const f = payload.features;

  // ── Bot signals (any one triggers) ──
  // Impossibly fast for writing 3 digits
  if (payload.completionTimeMs < 500) return "bot";
  // Synthetic event injection rate
  if (f.eventFrequencyHz > 300) return "bot";
  // Perfectly uniform movement with enough points to rule out coincidence
  if (f.speedVariance === 0 && f.totalPoints > 20) return "bot";

  // ── Human signals (all must hold) ──
  if (
    payload.passed === true &&
    f.speedVariance > 0 &&
    payload.completionTimeMs > 1000 &&
    payload.completionTimeMs < 45000 &&
    f.strokeCount >= 3 &&
    f.totalPoints > 10
  ) {
    return "human";
  }

  return "uncertain";
}
