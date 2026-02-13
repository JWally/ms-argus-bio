import { describe, it, expect } from 'vitest';
import { heuristicLabel } from './heuristics';
import type { BiometricPayload, AggregateFeatures } from './types';

function makePayload(overrides: {
  completionTimeMs?: number;
  passed?: boolean;
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
    inputType: 'mouse',
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
      expect(heuristicLabel(makePayload({ completionTimeMs: 200 }))).toBe('bot');
    });

    it('flags eventFrequencyHz > 300 as bot', () => {
      expect(heuristicLabel(makePayload({ features: { eventFrequencyHz: 500 } }))).toBe('bot');
    });

    it('flags zero speedVariance with many points as bot', () => {
      expect(heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 50 } }))).toBe(
        'bot'
      );
    });

    it('does NOT flag zero speedVariance with few points as bot', () => {
      // Few points could legitimately have zero variance
      expect(
        heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 10 } }))
      ).not.toBe('bot');
    });

    it('bot signals take priority over human signals', () => {
      // Meets human criteria but also triggers bot (too fast)
      expect(heuristicLabel(makePayload({ completionTimeMs: 100, passed: true }))).toBe('bot');
    });
  });

  describe('human signals', () => {
    it('labels as human when all human criteria are met', () => {
      expect(heuristicLabel(makePayload({}))).toBe('human');
    });

    it('requires passed === true', () => {
      expect(heuristicLabel(makePayload({ passed: false }))).toBe('uncertain');
    });

    it('requires speedVariance > 0', () => {
      // totalPoints <= 20 so it doesn't trigger bot rule
      expect(heuristicLabel(makePayload({ features: { speedVariance: 0, totalPoints: 15 } }))).toBe(
        'uncertain'
      );
    });

    it('requires completionTimeMs > 1000', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 800 }))).toBe('uncertain');
    });

    it('requires completionTimeMs < 45000', () => {
      expect(heuristicLabel(makePayload({ completionTimeMs: 50000 }))).toBe('uncertain');
    });

    it('requires strokeCount >= 3', () => {
      expect(heuristicLabel(makePayload({ features: { strokeCount: 2 } }))).toBe('uncertain');
    });

    it('requires totalPoints > 10', () => {
      expect(heuristicLabel(makePayload({ features: { totalPoints: 5 } }))).toBe('uncertain');
    });
  });

  describe('uncertain', () => {
    it('returns uncertain when neither bot nor human criteria are fully met', () => {
      // Not a bot (timing is fine) but not human (passed=false)
      expect(heuristicLabel(makePayload({ completionTimeMs: 2000, passed: false }))).toBe(
        'uncertain'
      );
    });
  });
});
