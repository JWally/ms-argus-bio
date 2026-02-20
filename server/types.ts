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
  /** APIs detected as tampered on the client (prototype lies) */
  tamperedApis?: string[];
}

export interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
  strokes: NormalizedStroke[];
  imageData: number[];
  /** Full 26-element softmax distribution (letters A-Z). Used by T3 for confidence-based validation. */
  allConfidences?: number[];
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
    coalescedCount: number;
    coalescedSpoofed?: boolean;
    movementX?: number;
    movementY?: number;
    predictedCount?: number;
    timestampDelta?: number;
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
  coalescedRatio: number;
  /** Fraction of move events with spoofed coalesced events (identical refs/coords/timestamps) */
  coalescedSpoofedRatio?: number;
  rafCadenceRatio: number;
  velocityBellScore: number;
  interStrokePauseCV: number;
  /** Whether the browser natively supports getCoalescedEvents (Safari doesn't) */
  coalescedSupported?: boolean;
  /** Ratio of move points where coords changed but both movementX and movementY are 0 */
  zeroMovementRatio?: number;
  /** Average predicted event count from getPredictedEvents(). Real: 1-3, CDP: 0 */
  avgPredictedCount?: number;
  /** Average delta between performance.now() and event.timeStamp. Real: 4-16ms, CDP: ~0ms */
  avgTimestampDelta?: number;
}

export type Label = 'human' | 'bot' | 'uncertain';

export interface Verdict {
  verdict: Label;
  confidence: number;
  neighborCount: number;
  challengeId: string;
}

// ── CAPTCHA-as-a-Service types ──

export interface Merchant {
  merchantId: string;
  name: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  allowedReturnUrls: string[];
  active: boolean;
  createdAt: number;
}

export interface Session {
  sessionId: string;
  merchantId: string;
  returnUrl: string;
  challenge: number[];
  status: 'pending' | 'completed' | 'expired';
  createdAt: number;
  ttl: number;
}

export interface Token {
  token: string;
  sessionId: string;
  merchantId: string;
  verdict: Label;
  confidence: number;
  redeemed: boolean;
  createdAt: number;
  ttl: number;
}

export interface SessionResponse {
  sessionId: string;
  captchaUrl: string;
}

export interface VerifyResponse {
  success: boolean;
  verdict?: Label;
  confidence?: number;
  sessionId?: string;
  timestamp?: number;
}

export interface ClassifyResponse extends Verdict {
  token?: string;
  returnUrl?: string;
}
