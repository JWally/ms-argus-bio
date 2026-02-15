import { useState, useCallback, useRef, useEffect } from 'react';
import * as tf from '@tensorflow/tfjs';
import { loadModel, predict, getImageData28x28 } from '../ml/model';
import DrawingCanvas, { type CanvasHandle, type Stroke } from '../components/DrawingCanvas';
import ResultDisplay from '../components/ResultDisplay';
import DotChallenge from '../components/DotChallenge';
import {
  computeFeatures,
  normalizeStrokes,
  type DigitResult,
  type ConfidenceSnapshot,
  type VerdictResult,
} from '../utils/biometrics';
import '../App.css';

type AppState = 'loading' | 'idle' | 'active' | 'complete';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const CONFIDENCE_THRESHOLD = 0.97;
const STABLE_CHECKS_NEEDED = 3;
const INFERENCE_INTERVAL_MS = 250;
const TIMEOUT_MS = 45_000;

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

function generateChallenge(): number[] {
  const n = Math.floor(Math.random() * 900) + 100;
  return [Math.floor(n / 100), Math.floor((n / 10) % 10), n % 10];
}

// ── CaptchaPage ─────────────────────────────────────────────────────

export default function CaptchaPage() {
  const [state, setState] = useState<AppState>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Initializing...');
  const [challenge, setChallenge] = useState<number[]>([]);
  const [currentDigitIndex, setCurrentDigitIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [currentConfidence, setCurrentConfidence] = useState(0);
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [argusToken, setArgusToken] = useState<string | null>(null);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);

  const modelRef = useRef<tf.LayersModel | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const timerRafRef = useRef(0);
  const inferenceRef = useRef(0);
  const stableCountRef = useRef(0);
  const activeRef = useRef(false);
  const startTimeRef = useRef(0);
  const digitStartTimeRef = useRef(0);
  const currentDigitIndexRef = useRef(0);
  const challengeRef = useRef<number[]>([]);
  const digitResultsRef = useRef<DigitResult[]>([]);
  const allStrokesRef = useRef<Stroke[]>([]);
  const confidenceTimelineRef = useRef<ConfidenceSnapshot[]>([]);
  const sessionIdRef = useRef<string | null>(
    new URLSearchParams(window.location.search).get('sid')
  );

  useEffect(() => {
    loadModel(setLoadingMsg).then((model) => {
      modelRef.current = model;
      const c = generateChallenge();
      setChallenge(c);
      challengeRef.current = c;
      setState('idle');
    });
  }, []);

  const logPayload = useCallback((totalTimeMs: number, timedOut: boolean) => {
    const payload = {
      challengeId: crypto.randomUUID(),
      challenge: challengeRef.current,
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
      ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
    };
    console.log('[ARGUS BIO] Biometric Payload', payload);

    if (API_URL) {
      fetch(`${API_URL}/v1/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => res.json())
        .then((v) => {
          console.log('[ARGUS BIO] Verdict', v);
          const result = v as VerdictResult;
          setVerdict(result);
          if (result.token) setArgusToken(result.token);
          if (result.returnUrl) setReturnUrl(result.returnUrl);
        })
        .catch((err) => {
          console.error('[ARGUS BIO] Classification error', err);
        });
    }
  }, []);

  // Start game on first canvas touch
  const handleCanvasPointerDown = useCallback(() => {
    if (activeRef.current || state === 'loading' || state === 'complete') return;
    if (state !== 'idle') return;

    canvasRef.current?.clear();
    activeRef.current = true;
    setState('active');

    const startTime = performance.now();
    startTimeRef.current = startTime;
    digitStartTimeRef.current = startTime;

    // Timer via rAF
    const tickTimer = () => {
      if (!activeRef.current) return;
      const elapsed = performance.now() - startTime;
      setElapsedMs(elapsed);

      if (elapsed >= TIMEOUT_MS) {
        activeRef.current = false;
        clearInterval(inferenceRef.current);
        const totalTime = TIMEOUT_MS;
        setFinalResult({
          totalTimeMs: totalTime,
          timedOut: true,
          digits: [...digitResultsRef.current],
          features: computeFeatures(allStrokesRef.current),
        });
        setState('complete');
        logPayload(totalTime, true);
        return;
      }
      timerRafRef.current = requestAnimationFrame(tickTimer);
    };
    timerRafRef.current = requestAnimationFrame(tickTimer);

    // Continuous inference
    inferenceRef.current = window.setInterval(() => {
      if (!activeRef.current) return;
      const canvas = canvasRef.current?.getCanvas();
      if (!canvas || !modelRef.current) return;

      const idx = currentDigitIndexRef.current;
      const targetDigit = challengeRef.current[idx];
      const { digit, confidence, allConfidences } = predict(modelRef.current, canvas);
      const targetConf = allConfidences[targetDigit];
      setCurrentConfidence(targetConf);

      confidenceTimelineRef.current.push({
        t: Math.round(performance.now() - startTime),
        digitIndex: idx,
        targetConf: Math.round(targetConf * 1000) / 1000,
        topDigit: digit,
        topConf: Math.round(confidence * 1000) / 1000,
      });

      if (targetConf >= CONFIDENCE_THRESHOLD && digit === targetDigit) {
        stableCountRef.current++;
        if (stableCountRef.current >= STABLE_CHECKS_NEEDED) {
          const now = performance.now();
          const strokes = canvasRef.current?.getStrokes() ?? [];
          const imgData = getImageData28x28(canvas);

          allStrokesRef.current.push(...strokes);
          digitResultsRef.current.push({
            target: targetDigit,
            recognized: digit,
            confidence: targetConf,
            timeMs: now - digitStartTimeRef.current,
            strokes: normalizeStrokes(strokes, startTime),
            imageData: imgData,
          });

          const nextIndex = idx + 1;
          if (nextIndex >= challengeRef.current.length) {
            // All digits done
            activeRef.current = false;
            cancelAnimationFrame(timerRafRef.current);
            clearInterval(inferenceRef.current);
            const totalTime = now - startTime;
            setElapsedMs(totalTime);
            setCurrentDigitIndex(nextIndex);
            setFinalResult({
              totalTimeMs: totalTime,
              timedOut: false,
              digits: [...digitResultsRef.current],
              features: computeFeatures(allStrokesRef.current),
            });
            setState('complete');
            logPayload(totalTime, false);
          } else {
            // Next digit
            currentDigitIndexRef.current = nextIndex;
            setCurrentDigitIndex(nextIndex);
            digitStartTimeRef.current = now;
            stableCountRef.current = 0;
            setCurrentConfidence(0);
            canvasRef.current?.clear();
          }
        }
      } else {
        stableCountRef.current = 0;
      }
    }, INFERENCE_INTERVAL_MS);
  }, [state, logPayload]);

  const handleReset = useCallback(() => {
    activeRef.current = false;
    cancelAnimationFrame(timerRafRef.current);
    clearInterval(inferenceRef.current);
    canvasRef.current?.clear();
    setElapsedMs(0);
    setCurrentConfidence(0);
    setCurrentDigitIndex(0);
    setFinalResult(null);
    setVerdict(null);
    setArgusToken(null);
    setReturnUrl(null);
    stableCountRef.current = 0;
    currentDigitIndexRef.current = 0;
    digitResultsRef.current = [];
    allStrokesRef.current = [];
    confidenceTimelineRef.current = [];
    const c = generateChallenge();
    setChallenge(c);
    challengeRef.current = c;
    setState('idle');
  }, []);

  const confLevel = currentConfidence >= 0.9 ? 'high' : currentConfidence >= 0.5 ? 'mid' : 'low';

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
    <div className="app">
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
                <DotChallenge digits={challenge} currentIndex={currentDigitIndex} />
              </div>
            </>
          )}

          {state !== 'complete' && (
            <div className={`canvas-area ${canvasState}`} onPointerDown={handleCanvasPointerDown}>
              <DrawingCanvas ref={canvasRef} idle={state === 'idle'} />

              <div className="confidence-track">
                <div
                  className="confidence-fill"
                  data-level={state === 'active' ? confLevel : 'idle'}
                  style={{
                    width: `${Math.round(currentConfidence * 100)}%`,
                  }}
                />
                <div className="confidence-threshold" />
              </div>
            </div>
          )}

          <div className="action-stack">
            {state === 'active' && (
              <button onClick={handleReset} className="btn btn-secondary btn-stack">
                Reset
              </button>
            )}
            {state === 'complete' && finalResult && (
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
  digits,
  features,
  verdict,
}: {
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
          {/* Per-digit breakdown */}
          <div className="stats-section">
            <div className="stats-section-title">Per-Digit Breakdown</div>
            <div className="stats-grid">
              {digits.map((d, i) => (
                <div key={i} className="stats-digit-card">
                  <div className="stats-digit-target">{d.target}</div>
                  <StatRow label="Recognized" value={d.recognized} />
                  <StatRow label="Confidence" value={`${(d.confidence * 100).toFixed(1)}%`} />
                  <StatRow label="Time" value={formatTime(d.timeMs)} />
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
