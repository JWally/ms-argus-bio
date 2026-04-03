import { describe, it, expect } from 'vitest';
import { encode, EMBEDDING_DIMS, EMBEDDING_VERSION } from './embedding';
import type { BiometricPayload, NormalizedStroke } from './types';

function makeStroke(points: { x: number; y: number; t: number }[]): NormalizedStroke {
  return {
    points: points.map((p) => ({
      ...p,
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
      width: 10,
      height: 10,
      coalescedCount: 1,
    })),
    startTime: points[0]?.t ?? 0,
    endTime: points[points.length - 1]?.t ?? 0,
  };
}

function makePayload(overrides?: Partial<BiometricPayload>) {
  const stroke1 = makeStroke([
    { x: 0.1, y: 0.1, t: 0 },
    { x: 0.2, y: 0.15, t: 50 },
    { x: 0.3, y: 0.2, t: 100 },
    { x: 0.35, y: 0.4, t: 150 },
    { x: 0.3, y: 0.6, t: 200 },
  ]);
  const stroke2 = makeStroke([
    { x: 0.5, y: 0.1, t: 300 },
    { x: 0.55, y: 0.3, t: 350 },
    { x: 0.6, y: 0.5, t: 400 },
  ]);

  return {
    challengeId: 'test-embed',
    challenge: [1, 2, 3],
    timestamp: Date.now(),
    completionTimeMs: 5000,
    passed: true,
    digits: [
      {
        target: 1,
        recognized: 1,
        confidence: 0.98,
        timeMs: 1500,
        strokes: [stroke1, stroke2],
        imageData: [],
      },
      {
        target: 2,
        recognized: 2,
        confidence: 0.95,
        timeMs: 1800,
        strokes: [stroke1],
        imageData: [],
      },
      {
        target: 3,
        recognized: 3,
        confidence: 0.97,
        timeMs: 1700,
        strokes: [stroke2],
        imageData: [],
      },
    ],
    confidenceTimeline: [
      { t: 100, digitIndex: 0, targetConf: 0.3, topDigit: 1, topConf: 0.5 },
      { t: 200, digitIndex: 0, targetConf: 0.7, topDigit: 1, topConf: 0.8 },
      { t: 400, digitIndex: 0, targetConf: 0.98, topDigit: 1, topConf: 0.98 },
      { t: 600, digitIndex: 1, targetConf: 0.2, topDigit: 2, topConf: 0.4 },
      { t: 800, digitIndex: 1, targetConf: 0.95, topDigit: 2, topConf: 0.95 },
    ],
    inputType: 'mouse',
    screenWidth: 1920,
    screenHeight: 1080,
    devicePixelRatio: 2,
    features: {
      strokeCount: 5,
      totalPoints: 100,
      avgSpeed: 0.5,
      speedVariance: 0.1,
      maxSpeed: 1.2,
      avgPressure: 0.5,
      pressureVariance: 0.05,
      avgContactWidth: 10,
      avgContactHeight: 10,
      totalDurationMs: 5000,
      avgTimeBetweenStrokes: 200,
      eventFrequencyHz: 60,
      avgJerk: 0.01,
      coalescedRatio: 0.5,
      rafCadenceRatio: 1.0,
      velocityBellScore: 0.7,
      interStrokePauseCV: 0.3,
    },
    ...overrides,
  } as BiometricPayload;
}

describe('encode', () => {
  it('produces a vector of exactly EMBEDDING_DIMS dimensions', () => {
    const vec = encode(makePayload());
    expect(vec).toHaveLength(EMBEDDING_DIMS);
  });

  it('all values are in [0, 1] range', () => {
    const vec = encode(makePayload());
    for (const v of vec) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('produces different vectors for different payloads', () => {
    const vec1 = encode(makePayload({ completionTimeMs: 1000 }));
    const vec2 = encode(makePayload({ completionTimeMs: 30000 }));
    const different = vec1.some((v, i) => v !== vec2[i]);
    expect(different).toBe(true);
  });

  it('produces deterministic output for the same input', () => {
    const payload = makePayload();
    expect(encode(payload)).toEqual(encode(payload));
  });

  it('handles different input types (one-hot encoding in dims 58-60)', () => {
    const mouseVec = encode(makePayload({ inputType: 'mouse' }));
    const touchVec = encode(makePayload({ inputType: 'touch' }));
    const penVec = encode(makePayload({ inputType: 'pen' }));

    // mouse one-hot: [1, 0, 0]
    expect(mouseVec[58]).toBe(1);
    expect(mouseVec[59]).toBe(0);
    expect(mouseVec[60]).toBe(0);

    // touch one-hot: [0, 1, 0]
    expect(touchVec[58]).toBe(0);
    expect(touchVec[59]).toBe(1);
    expect(touchVec[60]).toBe(0);

    // pen one-hot: [0, 0, 1]
    expect(penVec[58]).toBe(0);
    expect(penVec[59]).toBe(0);
    expect(penVec[60]).toBe(1);
  });

  it('encodes passed=true as 1 and passed=false as 0', () => {
    const passedVec = encode(makePayload({ passed: true }));
    const failedVec = encode(makePayload({ passed: false }));
    // Dim 29 is the passed flag
    expect(passedVec[29]).toBe(1);
    expect(failedVec[29]).toBe(0);
  });

  it('clamps extreme values to [0, 1]', () => {
    const extreme = makePayload({
      completionTimeMs: 999999,
      features: {
        strokeCount: 99999,
        totalPoints: 99999,
        avgSpeed: 99999,
        speedVariance: 99999,
        maxSpeed: 99999,
        avgPressure: 99999,
        pressureVariance: 99999,
        avgContactWidth: 99999,
        avgContactHeight: 99999,
        totalDurationMs: 99999,
        avgTimeBetweenStrokes: 99999,
        eventFrequencyHz: 99999,
        avgJerk: 99999,
        coalescedRatio: 99999,
        rafCadenceRatio: 99999,
        velocityBellScore: 99999,
        interStrokePauseCV: 99999,
      },
    });
    const vec = encode(extreme);
    for (const v of vec) {
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty strokes in digits gracefully', () => {
    const payload = makePayload();
    payload.digits[0].strokes = [];
    const vec = encode(payload);
    expect(vec).toHaveLength(EMBEDDING_DIMS);
    for (const v of vec) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty confidence timeline', () => {
    const vec = encode(makePayload({ confidenceTimeline: [] }));
    expect(vec).toHaveLength(EMBEDDING_DIMS);
  });

  it('handles fewer than 3 digits by zero-filling', () => {
    const payload = makePayload();
    payload.digits = [payload.digits[0]]; // Only 1 digit
    const vec = encode(payload);
    expect(vec).toHaveLength(EMBEDDING_DIMS);
    // Dims for digit 2 and 3 should be zero-filled
    // Digits start at dim 13, each digit = 5 dims
    // Digit 2 = dims 18-22, digit 3 = dims 23-27
    expect(vec[18]).toBe(0);
    expect(vec[19]).toBe(0);
    expect(vec[23]).toBe(0);
    expect(vec[24]).toBe(0);
  });
});

describe('constants', () => {
  it('EMBEDDING_DIMS is 88', () => {
    expect(EMBEDDING_DIMS).toBe(88);
  });

  it('EMBEDDING_VERSION is v7', () => {
    expect(EMBEDDING_VERSION).toBe('v7');
  });
});
