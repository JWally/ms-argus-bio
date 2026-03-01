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
  /** VM integrity hash — XOR-fold of features + deploy secret */
  vmHash?: string;
}

export interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
  strokes: NormalizedStroke[];
  imageData: number[];
  /** Full 26-element softmax distribution (letters A-Z). */
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
    rawUpdateCount?: number;
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
  /** Speed-curvature power law exponent. Human motor control: β ≈ 0.28-0.38 */
  powerLawBeta?: number;
  /** R² of the speed-curvature power law fit. Human: 0.3-0.7, Bot: < 0.15 */
  powerLawR2?: number;
  /** Variance of β across strokes */
  powerLawBetaVar?: number;
  /** Power ratio in 8-12 Hz tremor band. Human: 0.15-0.40, Bot: ~0.05 */
  tremorRatio?: number;
  /** Pearson correlation of pressure vs speed. Human touch: -0.2 to -0.6, Bot: ~0 */
  pressureVelocityR?: number;
  /** Velocity autocorrelation at lag 1. Human: 0.5-0.8, Bot: ~0 */
  velocityAutoCorr1?: number;
  /** Velocity autocorrelation at lag 2. Human: 0.2-0.5, Bot: ~0 */
  velocityAutoCorr2?: number;
  /** Velocity autocorrelation at lag 3 */
  velocityAutoCorr3?: number;
  /** Normalized position of peak speed (0-1). Human: 0.15-0.30, Bot: ~0.5 */
  ballisticOnset?: number;
  /** Log dimensionless jerk (smoothness). Lower = smoother = more human */
  logDimensionlessJerk?: number;
  /** Average velocity peaks per stroke. Human: 2-4, Bot: 0-1 or noisy */
  subStrokeCount?: number;
  /** Shannon entropy of movement direction histogram (16 bins) */
  directionEntropy?: number;
  /** Speed variance at endpoints / midstroke. Human < 1 (precise endpoints) */
  endpointPrecisionRatio?: number;
  /** Variance of contact area (width*height) over stroke. Touch: high, Mouse: 0 */
  contactAreaDynamics?: number;
  /** Average pointerrawupdate count per pointermove. Real: 2-15, Bot: 0 */
  avgRawUpdateCount?: number;
}

export type Label = 'human' | 'bot' | 'uncertain';

export interface Verdict {
  verdict: Label;
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
  score?: number;
  token?: string;
  returnUrl?: string;
}
