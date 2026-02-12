// server/types.ts
// Shared types mirroring the frontend payload structure

export interface BiometricPayload {
  challengeId: string;
  challenge: number[];
  timestamp: number;
  completionTimeMs: number;
  passed: boolean;
  digits: DigitResult[];
  confidenceTimeline: ConfidenceSnapshot[];
  inputType: 'mouse' | 'touch' | 'pen' | 'unknown';
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  userAgent: string;
  features: AggregateFeatures;
}

export interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
  strokes: NormalizedStroke[];
  imageData: number[];
}

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

export interface AggregateFeatures {
  strokeCount: number;
  totalPoints: number;
  avgSpeed: number;
  speedVariance: number;
  maxSpeed: number;
  avgPressure: number;
  pressureVariance: number;
  avgContactWidth: number;
  avgContactHeight: number;
  totalDurationMs: number;
  avgTimeBetweenStrokes: number;
  eventFrequencyHz: number;
  avgJerk: number;
}

export type Label = 'human' | 'bot' | 'uncertain';

export interface Verdict {
  verdict: Label;
  confidence: number;
  neighborCount: number;
  heuristicLabel: Label;
  challengeId: string;
}
