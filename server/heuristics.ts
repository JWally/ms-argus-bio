// server/heuristics.ts
// Auto-labeling rules for human/bot/uncertain classification

import type { BiometricPayload, Label } from './types';

// Sentinel value returned when there isn't enough data to compute a meaningful CV.
// Large enough that it never triggers a bot flag (all thresholds check < some threshold).
const TIMING_CV_NO_DATA = 999;

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
  if (dts.length < 2) return TIMING_CV_NO_DATA;
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  if (avg === 0) return 0;
  const stddev = Math.sqrt(dts.reduce((s, v) => s + (v - avg) ** 2, 0) / dts.length);
  return stddev / avg;
}

export interface HeuristicResult {
  label: Label;
  /** Which bot signal triggered, or 'human'/'uncertain' reason */
  reason: string;
}

/**
 * Apply heuristic rules to auto-label a biometric payload.
 * Returns both the label and the reason for debugging.
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
function getBotReason(payload: BiometricPayload): string | null {
  const f = payload.features;

  // ── Prototype tampering (instant kill) ──
  if (payload.tamperedApis && payload.tamperedApis.length > 0)
    return `tampered:${payload.tamperedApis.join(',')}`;

  // ── VM hash validation ──
  // If vmHash is present but empty/malformed → bytecode was tampered with
  if (payload.vmHash !== undefined && payload.vmHash !== '' && !/^\d+$/.test(payload.vmHash))
    return 'vm:invalid-hash';

  // ── Hard bot signals (any one triggers) ──
  if (payload.completionTimeMs < 500) return `fast:${payload.completionTimeMs}ms`;
  if (payload.completionTimeMs > 30_000) return `slow:${payload.completionTimeMs}ms`;
  if (f.eventFrequencyHz > 300) return `freq:${f.eventFrequencyHz.toFixed(1)}Hz`;
  if (f.speedVariance === 0 && f.totalPoints > 20) return 'zero-speed-variance';
  if (f.totalPoints > 20 && zeroDtRatio(payload) > 0.2)
    return `zeroDt:${(zeroDtRatio(payload) * 100).toFixed(1)}%`;

  // ── Coalesced / pressure signals ──
  // Only check when the client explicitly confirms the browser supports
  // getCoalescedEvents (Safari/iOS don't — they report 0 for both).
  // Using === true so missing/undefined field (old client JS) is also skipped.
  if (f.coalescedSupported === true && f.coalescedRatio === 0 && f.totalPoints > 20)
    return 'no-coalesced';
  // Threshold at 25% — real touch devices can hit 10-15% from slow/stationary
  // finger movements where coalesced events share rounded coordinates.
  // Actual spoofers (patched getCoalescedEvents) hit 80-100%.
  if ((f.coalescedSpoofedRatio ?? 0) > 0.25 && f.totalPoints > 20)
    return `coalesced-spoofed:${((f.coalescedSpoofedRatio ?? 0) * 100).toFixed(1)}%`;
  // Touch/pen with zero pressure variance = synthetic events, BUT only
  // when the browser actually reports non-zero pressure. iOS Safari reports
  // pressure: 0 for ALL touch events (even though it now supports
  // getCoalescedEvents since Safari 16+). Gate on avgPressure > 0 so we
  // only flag uniform pressure when the browser IS reporting it.
  if (
    (payload.inputType === 'touch' || payload.inputType === 'pen') &&
    f.avgPressure > 0 &&
    f.pressureVariance === 0 &&
    f.totalPoints > 20
  )
    return 'zero-pressure-touch';

  // ── CDP kill signals (movementX/Y, predictedEvents, timestampDelta) ──
  // zeroMovementRatio > 0.8: CDP-dispatched events never synthesize movementX/Y
  if ((f.zeroMovementRatio ?? -1) > 0.8 && f.totalPoints > 20)
    return `zeroMovement:${((f.zeroMovementRatio ?? 0) * 100).toFixed(0)}%`;
  // avgPredictedCount: demoted to embedding-only signal (dim 87).
  // Too many false positives across Firefox, Safari, and Linux Chrome (Wayland/X11).
  // avgTimestampDelta < 0.5ms: CDP events have near-zero delta (~0ms).
  // Threshold lowered from 1ms — Safari on macOS lands at 0.8-1ms legitimately.
  if ((f.avgTimestampDelta ?? 999) < 0.5 && f.totalPoints > 20)
    return `timestampDelta:${(f.avgTimestampDelta ?? 0).toFixed(2)}ms`;

  // ── rAF cadence analysis ──
  if (f.rafCadenceRatio < 0.35 && f.totalPoints > 20) return `raf:${f.rafCadenceRatio.toFixed(3)}`;

  // ── Inter-stroke pause uniformity ──
  if (f.interStrokePauseCV < 0.15 && f.strokeCount > 4)
    return `pauseCV:${f.interStrokePauseCV.toFixed(3)}`;

  return null;
}

function getHumanReason(payload: BiometricPayload): string | null {
  const f = payload.features;
  if (payload.passed !== true) return null;
  if (f.speedVariance <= 0) return null;
  if (payload.completionTimeMs <= 1000 || payload.completionTimeMs >= 30000) return null;
  if (f.strokeCount < 3) return null;
  if (f.totalPoints <= 10) return null;
  if (f.eventFrequencyHz < 10 || f.eventFrequencyHz > 200) return null;
  return 'all-human-signals';
}

export function heuristicLabel(payload: BiometricPayload): HeuristicResult {
  const botReason = getBotReason(payload);
  if (botReason) return { label: 'bot', reason: botReason };

  const humanReason = getHumanReason(payload);
  if (humanReason) return { label: 'human', reason: humanReason };

  // Build reason for uncertain
  const f = payload.features;
  const missing: string[] = [];
  if (!payload.passed) missing.push('not-passed');
  if (f.speedVariance <= 0) missing.push('no-speed-var');
  if (payload.completionTimeMs <= 1000) missing.push('too-fast');
  if (payload.completionTimeMs >= 30000) missing.push('too-slow');
  if (f.strokeCount < 3) missing.push(`strokes:${f.strokeCount}`);
  if (f.totalPoints <= 10) missing.push(`points:${f.totalPoints}`);
  if (f.eventFrequencyHz < 10) missing.push(`freq-low:${f.eventFrequencyHz.toFixed(1)}`);
  if (f.eventFrequencyHz > 200) missing.push(`freq-high:${f.eventFrequencyHz.toFixed(1)}`);
  return { label: 'uncertain', reason: missing.join(',') || 'unknown' };
}
