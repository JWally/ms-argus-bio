import { useState, useCallback, useRef, useEffect } from 'react';
import * as tf from '@tensorflow/tfjs';
import { loadModel, predict, getImageData28x28 } from '../ml/model';
import { loadLetterModel, predictLetter } from '../ml/letter-model';
import DrawingCanvas, { type CanvasHandle, type Stroke } from '../components/DrawingCanvas';
import ResultDisplay from '../components/ResultDisplay';
import DotChallenge from '../components/DotChallenge';
import {
  computeFeatures,
  normalizeStrokes,
  detectTampering,
  type DigitResult,
  type ConfidenceSnapshot,
  type VerdictResult,
} from '../utils/biometrics';
import { buildClientMask, CLIENT_MASK_WIDTH, CLIENT_MASK_HEIGHT } from '../utils/mask';
import '../App.css';

type AppState = 'loading' | 'idle' | 'active' | 'complete';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const TIMEOUT_MS = 45_000;

// ── Glyph type ──────────────────────────────────────────────────────
// The client no longer knows the character or modelIndex.
// It only knows the type (digit/letter) for model selection, and a mask for display.
interface Glyph {
  type: 'digit' | 'letter';
  /** Base64-encoded 1-bit packed mask from the server */
  mask: string;
}

// ── Fallback for local dev without API ──────────────────────────────
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface FallbackGlyph {
  char: string;
  type: 'digit' | 'letter';
  modelIndex: number;
}

const GLYPH_POOL: FallbackGlyph[] = [
  ...[2, 3, 4, 7].map((d) => ({
    char: String(d),
    type: 'digit' as const,
    modelIndex: d,
  })),
  ...['A', 'C', 'E', 'F', 'H', 'J', 'K', 'M', 'N', 'P', 'R', 'T', 'W', 'X', 'Y'].map((ch) => ({
    char: ch,
    type: 'letter' as const,
    modelIndex: LETTERS.indexOf(ch),
  })),
];

function generateFallbackChallenge(): Glyph[] {
  const len = 3 + Math.floor(Math.random() * 2); // 3 or 4
  const unique: FallbackGlyph[] = [];
  const used = new Set<string>();
  while (unique.length < len - 1) {
    const g = GLYPH_POOL[Math.floor(Math.random() * GLYPH_POOL.length)];
    if (!used.has(g.char)) {
      used.add(g.char);
      unique.push(g);
    }
  }
  const repeatIdx = Math.floor(Math.random() * unique.length);
  const all = [...unique, unique[repeatIdx]];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.map((g) => ({
    type: g.type,
    mask: buildClientMask(g.char),
  }));
}

// ── Types ────────────────────────────────────────────────────────────

interface FinalResult {
  totalTimeMs: number;
  timedOut: boolean;
  digits: DigitResult[];
  features: ReturnType<typeof computeFeatures>;
}

function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// ── CaptchaPage ─────────────────────────────────────────────────────

export default function CaptchaPage() {
  const [state, setState] = useState<AppState>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Initializing...');
  const [challenge, setChallenge] = useState<Glyph[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [flashColor, setFlashColor] = useState<'green' | 'red'>('green');
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [argusToken, setArgusToken] = useState<string | null>(null);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  const digitModelRef = useRef<tf.LayersModel | null>(null);
  const letterModelRef = useRef<tf.LayersModel | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const timerRafRef = useRef(0);
  const activeRef = useRef(false);
  const startTimeRef = useRef(0);
  const glyphStartTimeRef = useRef(0);
  const currentIndexRef = useRef(0);
  const challengeRef = useRef<Glyph[]>([]);
  const digitResultsRef = useRef<DigitResult[]>([]);
  const allStrokesRef = useRef<Stroke[]>([]);
  const confidenceTimelineRef = useRef<ConfidenceSnapshot[]>([]);
  const sessionIdRef = useRef<string | null>(
    new URLSearchParams(window.location.search).get('sid')
  );
  const challengeIdRef = useRef<string>('');
  const [maskDims, setMaskDims] = useState({ w: CLIENT_MASK_WIDTH, h: CLIENT_MASK_HEIGHT });

  /** Fetch a challenge from the server, or fall back to client-side generation */
  const fetchChallenge = useCallback(async (): Promise<Glyph[]> => {
    if (!API_URL) return generateFallbackChallenge();
    try {
      const res = await fetch(`${API_URL}/v1/challenge`);
      const data = await res.json();
      challengeIdRef.current = data.challengeId;
      setMaskDims({ w: data.maskWidth, h: data.maskHeight });
      const masks = data.masks as string[];
      const types = data.types as ('digit' | 'letter')[];
      return masks.map((mask, i) => ({ type: types[i], mask }));
    } catch {
      return generateFallbackChallenge();
    }
  }, []);

  // Load both models + fetch server challenge on mount
  useEffect(() => {
    const loadAll = async () => {
      const [digitModel, letterModel, c] = await Promise.all([
        loadModel(setLoadingMsg),
        loadLetterModel(),
        fetchChallenge(),
      ]);
      digitModelRef.current = digitModel;
      letterModelRef.current = letterModel;

      setChallenge(c);
      challengeRef.current = c;
      setState('idle');
    };
    loadAll();
  }, [fetchChallenge]);

  const logPayload = useCallback((totalTimeMs: number, timedOut: boolean) => {
    const payload = {
      challengeId: challengeIdRef.current || crypto.randomUUID(),
      // Don't leak expected answers — just send glyph types
      challenge: challengeRef.current.map((g) => (g.type === 'digit' ? 0 : 1)),
      timestamp: Date.now(),
      completionTimeMs: totalTimeMs,
      passed: !timedOut,
      digits: digitResultsRef.current,
      confidenceTimeline: confidenceTimelineRef.current,
      inputType: canvasRef.current?.getInputType() ?? 'unknown',
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      features: computeFeatures(allStrokesRef.current),
      tamperedApis: detectTampering(),
      ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
    };
    // eslint-disable-next-line no-console
    console.log('[ARGUS BIO] Biometric Payload', payload);

    const fallbackVerdict: VerdictResult = {
      verdict: 'uncertain',
      confidence: 0,
      neighborCount: 0,
      heuristicLabel: 'no-api',
    };

    if (!API_URL) {
      setVerdict(fallbackVerdict);
      return;
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);

    fetch(`${API_URL}/v1/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
      .then((res) => res.json())
      .then((v) => {
        // eslint-disable-next-line no-console
        console.log('[ARGUS BIO] Verdict', v);
        if (v.retry) {
          setRetryMsg(v.message || 'Incorrect. Try again!');
          return;
        }
        const result = v as VerdictResult;
        setVerdict(result);
        if (result.token) setArgusToken(result.token);
        if (result.returnUrl) setReturnUrl(result.returnUrl);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[ARGUS BIO] Classification error', err);
        setVerdict(fallbackVerdict);
      })
      .finally(() => clearTimeout(timeout));
  }, []);

  /** Run inference for the current glyph using the appropriate model.
   *  Client no longer knows the expected answer — only checks recognizability. */
  const runInference = useCallback(
    (
      canvas: HTMLCanvasElement,
      glyphType: 'digit' | 'letter'
    ): { topIndex: number; topConf: number } => {
      if (glyphType === 'digit' && digitModelRef.current) {
        const { digit, confidence } = predict(digitModelRef.current, canvas);
        return { topIndex: digit, topConf: confidence };
      } else if (glyphType === 'letter' && letterModelRef.current) {
        const { confidence, allConfidences } = predictLetter(letterModelRef.current, canvas, {
          x: 0,
          y: 0,
          w: canvas.width,
          h: canvas.height,
        });
        const topIdx = allConfidences.indexOf(Math.max(...allConfidences));
        return { topIndex: topIdx, topConf: confidence };
      }
      return { topIndex: -1, topConf: 0 };
    },
    []
  );

  // Start game on first canvas touch
  const handleCanvasPointerDown = useCallback(() => {
    if (activeRef.current || state === 'loading' || state === 'complete') return;
    if (state !== 'idle') return;

    canvasRef.current?.clear();
    activeRef.current = true;
    setState('active');

    const startTime = performance.now();
    startTimeRef.current = startTime;
    glyphStartTimeRef.current = startTime;

    // Timer via rAF
    const tickTimer = () => {
      if (!activeRef.current) return;
      const elapsed = performance.now() - startTime;
      setElapsedMs(elapsed);

      if (elapsed >= TIMEOUT_MS) {
        activeRef.current = false;
        setFinalResult({
          totalTimeMs: TIMEOUT_MS,
          timedOut: true,
          digits: [...digitResultsRef.current],
          features: computeFeatures(allStrokesRef.current),
        });
        setState('complete');
        return;
      }
      timerRafRef.current = requestAnimationFrame(tickTimer);
    };
    timerRafRef.current = requestAnimationFrame(tickTimer);
  }, [state]);

  const advance = useCallback(
    (now: number) => {
      const nextIndex = currentIndexRef.current + 1;
      if (nextIndex >= challengeRef.current.length) {
        activeRef.current = false;
        cancelAnimationFrame(timerRafRef.current);
        const totalTime = now - startTimeRef.current;
        setElapsedMs(totalTime);
        setCurrentIndex(nextIndex);
        setFinalResult({
          totalTimeMs: totalTime,
          timedOut: false,
          digits: [...digitResultsRef.current],
          features: computeFeatures(allStrokesRef.current),
        });
        setState('complete');
        logPayload(totalTime, false);
      } else {
        currentIndexRef.current = nextIndex;
        setCurrentIndex(nextIndex);
        glyphStartTimeRef.current = now;
        canvasRef.current?.clear();
      }
    },
    [logPayload]
  );

  const handleNext = useCallback(() => {
    if (!activeRef.current) return;
    const canvas = canvasRef.current?.getCanvas();
    if (!canvas) return;

    const idx = currentIndexRef.current;
    const glyph = challengeRef.current[idx];
    if (!glyph) return;

    const { topIndex, topConf } = runInference(canvas, glyph.type);
    const now = performance.now();
    const strokes = canvasRef.current?.getStrokes() ?? [];
    const imgData = getImageData28x28(canvas);

    confidenceTimelineRef.current.push({
      t: Math.round(now - startTimeRef.current),
      digitIndex: idx,
      targetConf: 0, // Client no longer knows the target
      topDigit: topIndex,
      topConf: Math.round(topConf * 1000) / 1000,
    });

    allStrokesRef.current.push(...strokes);
    digitResultsRef.current.push({
      target: -1, // Hidden — server decrypts from challengeId
      recognized: topIndex,
      confidence: topConf,
      timeMs: now - glyphStartTimeRef.current,
      strokes: normalizeStrokes(strokes, startTimeRef.current),
      imageData: imgData,
    });

    // Client only checks: "is this a recognizable character?"
    // NOT "is this the RIGHT character?" — server validates that.
    // This prevents bots from using green/red feedback to retry per glyph.
    const RECOGNITION_THRESHOLD = 0.15;
    if (topConf > RECOGNITION_THRESHOLD) {
      // Recognizable character — advance (server will validate correctness)
      advance(now);
    } else {
      // Unrecognizable scribble — retry with red flash
      setFlashColor('red');
      setFlashKey((k) => k + 1);
      glyphStartTimeRef.current = now;
      canvasRef.current?.clear();
    }
  }, [runInference, advance]);

  const handleErase = useCallback(() => {
    canvasRef.current?.clear();
  }, []);

  const handleReset = useCallback(async () => {
    activeRef.current = false;
    cancelAnimationFrame(timerRafRef.current);
    canvasRef.current?.clear();
    setElapsedMs(0);
    setCurrentIndex(0);
    setFinalResult(null);
    setVerdict(null);
    setArgusToken(null);
    setReturnUrl(null);
    setRetryMsg(null);
    currentIndexRef.current = 0;
    digitResultsRef.current = [];
    allStrokesRef.current = [];
    confidenceTimelineRef.current = [];

    const c = await fetchChallenge();
    setChallenge(c);
    challengeRef.current = c;
    setState('idle');
  }, [fetchChallenge]);

  // Auto-reset after a retry (challenge mismatch)
  useEffect(() => {
    if (!retryMsg) return;
    const id = setTimeout(() => handleReset(), 2500);
    return () => clearTimeout(id);
  }, [retryMsg, handleReset]);

  const timerClass = [
    'timer',
    state === 'active' && 'timer-active',
    state === 'complete' && !finalResult?.timedOut && 'timer-success',
    state === 'complete' && finalResult?.timedOut && 'timer-fail',
  ]
    .filter(Boolean)
    .join(' ');

  const canvasState = state === 'idle' ? 'canvas-idle' : state === 'active' ? 'canvas-active' : '';

  return (
    <div className={`app ${state === 'complete' ? 'app-complete' : ''}`}>
      {flashKey > 0 && <div key={flashKey} className={`flash-overlay flash-${flashColor}`} />}
      <header>
        <h1>
          ARGUS <span className="accent">BIO</span>
        </h1>
        <p className="subtitle">Handwriting Biometric Captcha</p>
      </header>

      {state === 'loading' && (
        <div className="loading-panel">
          <div className="spinner" />
          <p className="loading-msg">{loadingMsg}</p>
        </div>
      )}

      {state !== 'loading' && (
        <main>
          {state !== 'complete' && (
            <>
              <div className={timerClass}>{formatTime(elapsedMs)}</div>

              <div className="challenge-digits">
                <DotChallenge
                  masks={challenge.map((g) => g.mask)}
                  maskWidth={maskDims.w}
                  maskHeight={maskDims.h}
                  currentIndex={currentIndex}
                />
              </div>
            </>
          )}

          {state !== 'complete' && (
            <div className={`canvas-area ${canvasState}`} onPointerDown={handleCanvasPointerDown}>
              <DrawingCanvas ref={canvasRef} />
              {state === 'idle' && (
                <div className="canvas-overlay">
                  <p className="canvas-overlay-text">Draw the Characters You See Above</p>
                  <p className="canvas-overlay-start">-- CLICK HERE TO START --</p>
                </div>
              )}
            </div>
          )}

          <div className="action-stack">
            {(state === 'idle' || state === 'active') && (
              <>
                <button
                  onClick={handleNext}
                  className="btn btn-next btn-stack"
                  disabled={state === 'idle'}
                >
                  Next
                </button>
                <button
                  onClick={handleErase}
                  className="btn btn-erase btn-stack"
                  disabled={state === 'idle'}
                >
                  Erase
                </button>
              </>
            )}
            {state === 'complete' && retryMsg && (
              <div className="retry-panel">
                <div className="retry-icon">&#x21bb;</div>
                <p className="retry-message">{retryMsg}</p>
                <p className="retry-sub">Resetting automatically&hellip;</p>
              </div>
            )}
            {state === 'complete' && finalResult && !retryMsg && (
              <>
                <ResultDisplay
                  totalTimeMs={finalResult.totalTimeMs}
                  timedOut={finalResult.timedOut}
                  verdict={verdict}
                />
                <button onClick={handleReset} className="btn btn-primary btn-stack">
                  Try Again
                </button>
                <button
                  className={`btn btn-stack ${argusToken && returnUrl ? 'btn-primary' : 'btn-secondary'}`}
                  disabled={!argusToken || !returnUrl}
                  onClick={() => {
                    if (argusToken && returnUrl) {
                      window.location.href = `${returnUrl}?argus_token=${encodeURIComponent(argusToken)}`;
                    }
                  }}
                >
                  Continue
                </button>
                <StatsDrawer
                  glyphs={challenge}
                  digits={finalResult.digits}
                  features={finalResult.features}
                  verdict={verdict}
                />
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

function StatsDrawer({
  glyphs,
  digits,
  features,
  verdict,
}: {
  glyphs: Glyph[];
  digits: DigitResult[];
  features: ReturnType<typeof computeFeatures>;
  verdict: VerdictResult | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="stats-wrapper">
      <button
        className="btn btn-secondary btn-stack btn-stats-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Stats
        <span className={`stats-chevron ${open ? 'stats-chevron-open' : ''}`}>&#9662;</span>
      </button>

      <div className={`stats-drawer ${open ? 'stats-drawer-open' : ''}`}>
        <div className="stats-content">
          {/* Per-glyph breakdown */}
          <div className="stats-section">
            <div className="stats-section-title">Per-Glyph Breakdown</div>
            <div className="stats-grid">
              {digits.map((d, i) => (
                <div key={i} className="stats-digit-card">
                  <div className="stats-digit-target">
                    #{i + 1} ({glyphs[i]?.type ?? '?'})
                  </div>
                  <div className="stats-digit-label">Confidence</div>
                  <div className="stats-digit-value">{(d.confidence * 100).toFixed(1)}%</div>
                  <div className="stats-digit-label">Time</div>
                  <div className="stats-digit-value">{(d.timeMs / 1000).toFixed(2)}s</div>
                </div>
              ))}
            </div>
          </div>

          {/* Biometric features */}
          <div className="stats-section">
            <div className="stats-section-title">Biometric Features</div>
            <div className="stats-table">
              <StatRow label="Strokes" value={features.strokeCount} />
              <StatRow label="Total Points" value={features.totalPoints} />
              <StatRow label="Avg Speed" value={features.avgSpeed.toFixed(3)} unit="px/ms" />
              <StatRow label="Max Speed" value={features.maxSpeed.toFixed(3)} unit="px/ms" />
              <StatRow label="Speed Variance" value={features.speedVariance.toFixed(4)} />
              <StatRow label="Avg Pressure" value={features.avgPressure.toFixed(3)} />
              <StatRow
                label="Event Frequency"
                value={features.eventFrequencyHz.toFixed(1)}
                unit="Hz"
              />
              <StatRow label="Avg Jerk" value={features.avgJerk.toFixed(5)} />
              <StatRow label="Total Duration" value={formatTime(features.totalDurationMs)} />
              <StatRow
                label="Avg Stroke Gap"
                value={features.avgTimeBetweenStrokes.toFixed(0)}
                unit="ms"
              />
            </div>
          </div>

          {/* Classification details */}
          {verdict && (
            <div className="stats-section">
              <div className="stats-section-title">Classification</div>
              <div className="stats-table">
                <StatRow label="Verdict" value={verdict.verdict.toUpperCase()} />
                <StatRow label="Confidence" value={`${Math.round(verdict.confidence * 100)}%`} />
                <StatRow label="Neighbors" value={verdict.neighborCount} />
                <StatRow label="Heuristic" value={verdict.heuristicLabel} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="stats-row">
      <span className="stats-label">{label}</span>
      <span className="stats-value">
        {value}
        {unit && <span className="stats-unit"> {unit}</span>}
      </span>
    </div>
  );
}
