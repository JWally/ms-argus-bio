import { useState, useCallback, useRef, useEffect } from 'react';
import * as tf from '@tensorflow/tfjs';
import { loadModel, predict, getImageData28x28 } from './ml/model';
import DrawingCanvas, {
  type CanvasHandle,
  type Stroke,
  type StrokePoint,
} from './components/DrawingCanvas';
import ResultDisplay from './components/ResultDisplay';
import './App.css';

type AppState = 'loading' | 'idle' | 'active' | 'complete';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const CONFIDENCE_THRESHOLD = 0.97;
const STABLE_CHECKS_NEEDED = 3;
const INFERENCE_INTERVAL_MS = 250;
const TIMEOUT_MS = 45_000;

interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
  strokes: NormalizedStroke[];
  imageData: number[];
}

interface NormalizedStroke {
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

interface ConfidenceSnapshot {
  t: number;
  digitIndex: number;
  targetConf: number;
  topDigit: number;
  topConf: number;
}

interface FinalResult {
  totalTimeMs: number;
  timedOut: boolean;
  digits: DigitResult[];
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

// ── Biometric feature computation ────────────────────────────────────

function computeFeatures(strokes: Stroke[]) {
  const allPoints: StrokePoint[] = strokes.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return {
      strokeCount: strokes.length,
      totalPoints: allPoints.length,
      avgSpeed: 0,
      speedVariance: 0,
      maxSpeed: 0,
      avgPressure: 0,
      pressureVariance: 0,
      avgContactWidth: 0,
      avgContactHeight: 0,
      totalDurationMs: 0,
      avgTimeBetweenStrokes: 0,
      eventFrequencyHz: 0,
      avgJerk: 0,
    };
  }

  const speeds: number[] = [];
  const accelerations: number[] = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 1];
      const p1 = stroke.points[i];
      const dt = p1.t - p0.t;
      if (dt > 0) {
        speeds.push(
          Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt
        );
      }
    }
    for (let i = 2; i < stroke.points.length; i++) {
      const p0 = stroke.points[i - 2];
      const p1 = stroke.points[i - 1];
      const p2 = stroke.points[i];
      const dt1 = p1.t - p0.t;
      const dt2 = p2.t - p1.t;
      if (dt1 > 0 && dt2 > 0) {
        const s1 =
          Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2) / dt1;
        const s2 =
          Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2) / dt2;
        accelerations.push((s2 - s1) / ((dt1 + dt2) / 2));
      }
    }
  }

  const jerks: number[] = [];
  for (let i = 1; i < accelerations.length; i++) {
    jerks.push(Math.abs(accelerations[i] - accelerations[i - 1]));
  }

  const avg = (a: number[]) =>
    a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const variance = (a: number[]) => {
    const m = avg(a);
    return a.length ? a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length : 0;
  };

  const pressures = allPoints.map((p) => p.pressure);
  const widths = allPoints.map((p) => p.width);
  const heights = allPoints.map((p) => p.height);
  const strokeGaps: number[] = [];
  for (let i = 1; i < strokes.length; i++) {
    strokeGaps.push(strokes[i].startTime - strokes[i - 1].endTime);
  }
  const totalTime = allPoints[allPoints.length - 1].t - allPoints[0].t;

  return {
    strokeCount: strokes.length,
    totalPoints: allPoints.length,
    avgSpeed: avg(speeds),
    speedVariance: variance(speeds),
    maxSpeed: speeds.length ? Math.max(...speeds) : 0,
    avgPressure: avg(pressures),
    pressureVariance: variance(pressures),
    avgContactWidth: avg(widths),
    avgContactHeight: avg(heights),
    totalDurationMs: totalTime,
    avgTimeBetweenStrokes: avg(strokeGaps),
    eventFrequencyHz:
      totalTime > 0 ? (allPoints.length / totalTime) * 1000 : 0,
    avgJerk: avg(jerks),
  };
}

function normalizeStrokes(
  strokes: Stroke[],
  startTime: number
): NormalizedStroke[] {
  const sz = 280;
  return strokes.map((s) => ({
    points: s.points.map((p) => ({
      x: p.x / sz,
      y: p.y / sz,
      t: p.t - startTime,
      pressure: p.pressure,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      width: p.width,
      height: p.height,
    })),
    startTime: s.startTime - startTime,
    endTime: s.endTime - startTime,
  }));
}

// ── App ──────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<AppState>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Initializing...');
  const [challenge, setChallenge] = useState<number[]>([]);
  const [currentDigitIndex, setCurrentDigitIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [currentConfidence, setCurrentConfidence] = useState(0);
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);

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

  useEffect(() => {
    loadModel(setLoadingMsg).then((model) => {
      modelRef.current = model;
      const c = generateChallenge();
      setChallenge(c);
      challengeRef.current = c;
      setState('idle');
    });
  }, []);

  const logPayload = useCallback(
    (totalTimeMs: number, timedOut: boolean) => {
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
      };
      console.log('[ARGUS BIO] Biometric Payload', payload);

      if (API_URL) {
        fetch(`${API_URL}/v1/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((res) => res.json())
          .then((verdict) => {
            console.log('[ARGUS BIO] Verdict', verdict);
          })
          .catch((err) => {
            console.error('[ARGUS BIO] Classification error', err);
          });
      }
    },
    []
  );

  // Start game on first canvas touch
  const handleCanvasPointerDown = useCallback(() => {
    if (activeRef.current || state === 'loading' || state === 'complete')
      return;
    if (state !== 'idle') return;

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
      const { digit, confidence, allConfidences } = predict(
        modelRef.current,
        canvas
      );
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

  const confLevel =
    currentConfidence >= 0.9
      ? 'high'
      : currentConfidence >= 0.5
        ? 'mid'
        : 'low';

  const timerClass = [
    'timer',
    state === 'active' && 'timer-active',
    state === 'complete' && !finalResult?.timedOut && 'timer-success',
    state === 'complete' && finalResult?.timedOut && 'timer-fail',
  ]
    .filter(Boolean)
    .join(' ');

  const canvasState =
    state === 'idle'
      ? 'canvas-idle'
      : state === 'active'
        ? 'canvas-active'
        : '';

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
              <div className="challenge-digits">
                {challenge.map((d, i) => (
                  <span
                    key={i}
                    className={[
                      'challenge-digit',
                      i < currentDigitIndex && 'digit-done',
                      i === currentDigitIndex && 'digit-current',
                      i > currentDigitIndex && 'digit-upcoming',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {d}
                  </span>
                ))}
              </div>

              <div className={timerClass}>{formatTime(elapsedMs)}</div>
            </>
          )}

          {state !== 'complete' && (
            <div
              className={`canvas-area ${canvasState}`}
              onPointerDown={handleCanvasPointerDown}
            >
              <DrawingCanvas ref={canvasRef} />

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

              {state === 'idle' && (
                <p className="touch-hint">Touch canvas to begin</p>
              )}
            </div>
          )}

          <div className="action-stack">
            {state === 'active' && (
              <button
                onClick={handleReset}
                className="btn btn-secondary btn-stack"
              >
                Reset
              </button>
            )}
            {state === 'complete' && finalResult && (
              <>
                <ResultDisplay
                  totalTimeMs={finalResult.totalTimeMs}
                  timedOut={finalResult.timedOut}
                />
                <button
                  onClick={handleReset}
                  className="btn btn-primary btn-stack"
                >
                  Try Again
                </button>
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
