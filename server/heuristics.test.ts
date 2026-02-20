import { describe, it, expect } from 'vitest';
import { heuristicLabel } from './heuristics';
import type { BiometricPayload, AggregateFeatures } from './types';

function makePayload(overrides: {
  completionTimeMs?: number;
  passed?: boolean;
  inputType?: BiometricPayload['inputType'];
  features?: Partial<AggregateFeatures>;
}): BiometricPayload {
  const defaultFeatures: AggregateFeatures = {
    strokeCount: 5,
    totalPoints: 100,
    avgSpeed: 0.5,
    speedVariance: 0.1,
    maxSpeed: 1.0,
    avgPressure: 0.5,
    pressureVariance: 0.05,
    avgContactWidth: 10,
    avgContactHeight: 10,
    totalDurationMs: 3000,
    avgTimeBetweenStrokes: 200,
    eventFrequencyHz: 60,
    avgJerk: 0.01,
    coalescedRatio: 0.5,
    rafCadenceRatio: 0.6,
    velocityBellScore: 0.5,
    interStrokePauseCV: 0.5,
    coalescedSupported: true,
  };

  return {
    challengeId: 'test',
    challenge: [1, 2, 3],
    timestamp: Date.now(),
    completionTimeMs: overrides.completionTimeMs ?? 3000,
    passed: overrides.passed ?? true,
    digits: [
      {
        target: 1,
        recognized: 1,
        confidence: 0.99,
        timeMs: 1000,
        strokes: [],
        imageData: [],
      },
    ],
    confidenceTimeline: [],
    inputType: overrides.inputType ?? 'mouse',
    screenWidth: 1920,
    screenHeight: 1080,
    devicePixelRatio: 2,
    userAgent: 'test-agent',
    features: { ...defaultFeatures, ...overrides.features },
  } as BiometricPayload;
}

describe('heuristicLabel', () => {
  describe('bot signals', () => {
    it('flags completionTimeMs < 500 as bot', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 200 })).label).toBe('bot');
    });

    it('flags eventFrequencyHz > 300 as bot', () => {
      expect(heuristicLabel(makePayload({ features: { eventFrequencyHz: 500 } })).label).toBe(
        'bot'
      );
    });

    it('flags zero speedVariance with many points as bot', () => {
      expect(
        heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 50 } })).label
      ).toBe('bot');
    });

    it('does NOT flag zero speedVariance with few points as bot', () => {
      expect(
        heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 10 } })).label
      ).not.toBe('bot');
    });

    it('bot signals take priority over human signals', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 100, passed: true })).label).toBe(
        'bot'
      );
    });

    it('flags zero pressure variance on touch when avgPressure > 0', () => {
      const result = heuristicLabel(
        makePayload({
          inputType: 'touch',
          features: { avgPressure: 0.5, pressureVariance: 0, totalPoints: 50 },
        })
      );
      expect(result.label).toBe('bot');
      expect(result.reason).toBe('zero-pressure-touch');
    });

    it('does NOT flag zero pressure on iOS Safari (avgPressure === 0)', () => {
      // iOS Safari reports pressure: 0 for all touch events — not a bot signal
      const result = heuristicLabel(
        makePayload({
          inputType: 'touch',
          features: {
            avgPressure: 0,
            pressureVariance: 0,
            totalPoints: 50,
            coalescedSupported: true,
          },
        })
      );
      expect(result.label).not.toBe('bot');
    });

    it('flags zeroMovementRatio > 0.8 as bot (CDP kill shot)', () => {
      const result = heuristicLabel(
        makePayload({ features: { zeroMovementRatio: 0.95, totalPoints: 50 } })
      );
      expect(result.label).toBe('bot');
      expect(result.reason).toMatch(/^zeroMovement:/);
    });

    it('does NOT flag zeroMovementRatio with few points', () => {
      const result = heuristicLabel(
        makePayload({ features: { zeroMovementRatio: 0.95, totalPoints: 15 } })
      );
      expect(result.label).not.toBe('bot');
    });

    it('flags avgPredictedCount === 0 with 30+ points as bot', () => {
      const result = heuristicLabel(
        makePayload({ features: { avgPredictedCount: 0, totalPoints: 50 } })
      );
      expect(result.label).toBe('bot');
      expect(result.reason).toBe('no-predicted-events');
    });

    it('does NOT flag avgPredictedCount === 0 with few points', () => {
      const result = heuristicLabel(
        makePayload({ features: { avgPredictedCount: 0, totalPoints: 20 } })
      );
      expect(result.reason).not.toBe('no-predicted-events');
    });

    it('flags avgTimestampDelta < 1ms as bot', () => {
      const result = heuristicLabel(
        makePayload({ features: { avgTimestampDelta: 0.3, totalPoints: 50 } })
      );
      expect(result.label).toBe('bot');
      expect(result.reason).toMatch(/^timestampDelta:/);
    });

    it('does NOT flag avgTimestampDelta when field is missing (old client)', () => {
      // Old clients don't send these fields — defaults must not trigger
      const result = heuristicLabel(makePayload({ features: { totalPoints: 50 } }));
      expect(result.reason).not.toMatch(/zeroMovement|no-predicted|timestampDelta/);
    });
  });

  describe('human signals', () => {
    it('labels as human when all human criteria are met', () => {
      expect(heuristicLabel(makePayload({})).label).toBe('human');
    });

    it('requires passed === true', () => {
      expect(heuristicLabel(makePayload({ passed: false })).label).toBe('uncertain');
    });

    it('requires speedVariance > 0', () => {
      expect(
        heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 15 } })).label
      ).toBe('uncertain');
    });

    it('requires completionTimeMs > 1000', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 800 })).label).toBe('uncertain');
    });

    it('requires completionTimeMs < 45000', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 50000 })).label).toBe('uncertain');
    });

    it('requires strokeCount >= 3', () => {
      expect(heuristicLabel(makePayload({ features: { strokeCount: 2 } })).label).toBe('uncertain');
    });

    it('requires totalPoints > 10', () => {
      expect(heuristicLabel(makePayload({ features: { totalPoints: 5 } })).label).toBe('uncertain');
    });
  });

  describe('uncertain', () => {
    it('returns uncertain when neither bot nor human criteria are fully met', () => {
      const result = heuristicLabel(makePayload({ completionTimeMs: 2000, passed: false }));
      expect(result.label).toBe('uncertain');
      expect(result.reason).toContain('not-passed');
    });
  });
});
