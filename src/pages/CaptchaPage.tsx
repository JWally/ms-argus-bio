import { useState, useCallback, useRef, useEffect } from 'react';
import { getImageData28x28 } from '../ml/preprocess';
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
import { measureSync, observeLongTasks } from '../utils/perf';
import { isEmbedded } from '../utils/embed';
import {
  loadProgress,
  saveProgress,
  generateBoard,
  getNextTier,
  type Tier,
  type BoardEntry,
} from '../utils/progression';
import { useChallenge } from '../hooks/useChallenge';
import { useVerdictFlow } from '../hooks/useVerdictFlow';
import { MSG_ERROR, MSG_VERIFIED } from '../constants';
import '../App.css';

type AppState = 'loading' | 'idle' | 'active' | 'complete';

const TIMEOUT_MS = 30_000;
const MEASURE_BIOMETRICS = 'compute:biometrics';
const LOADING_MSG = 'Initializing...';

// Start long-task observer for profiling
observeLongTasks();

// Lock body to viewport when embedded in iframe
if (isEmbedded()) document.body.classList.add('embedded');

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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);

  // Progression state
  const [progress, setProgress] = useState(loadProgress);
  const [boardEntries, setBoardEntries] = useState<BoardEntry[]>([]);
  const [tierCleared, setTierCleared] = useState(false);
  const [boardMode, setBoardMode] = useState<'normal' | 'cleared' | 'shake' | 'off-pace'>('normal');
  const [isNewPR, setIsNewPR] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  const timerRafRef = useRef(0);
  const activeRef = useRef(false);
  const startTimeRef = useRef(0);
  const glyphStartTimeRef = useRef(0);
  const currentIndexRef = useRef(0);
  const digitResultsRef = useRef<DigitResult[]>([]);
  const allStrokesRef = useRef<Stroke[]>([]);
  const confidenceTimelineRef = useRef<ConfidenceSnapshot[]>([]);

  const onChallengeReady = useCallback(() => setState('idle'), []);

  const {
    challenge,
    challengeRef,
    imageDims,
    sessionError,
    challengeIdRef,
    rawPublicKeyRef,
    serverPubKeyRef,
    sessionIdRef,
    reload: reloadChallenge,
  } = useChallenge(onChallengeReady);

  const {
    verdict,
    argusToken,
    returnUrl,
    retryMsg,
    submitPayload,
    reset: resetVerdict,
  } = useVerdictFlow({
    allStrokesRef,
    digitResultsRef,
    confidenceTimelineRef,
    canvasRef,
    challengeRef,
    challengeIdRef,
    rawPublicKeyRef,
    serverPubKeyRef,
    sessionIdRef,
  });

  // Generate tier board + update PR when captcha completes
  const updateBoardAndProgress = useCallback(
    (timeMs: number) => {
      const tier = progress.currentTier;
      const prev = progress.bestByTier[tier];
      const baseline = progress.baselineByTier?.[tier];

      const board = generateBoard(timeMs, tier, progress.playerId, baseline);
      setBoardEntries(board);

      const playerEntry = board.find((e) => e.isPlayer);
      const rank = playerEntry?.rank ?? board.length;
      const beatPR = prev !== undefined && timeMs < prev;

      if (rank === 1 && getNextTier(tier)) {
        setBoardMode('cleared');
        setTierCleared(true);
      } else if (!prev || beatPR) {
        setBoardMode('normal');
      } else if (rank <= 5) {
        setBoardMode('shake');
      } else {
        setBoardMode('off-pace');
      }

      setIsNewPR(beatPR);

      if (!prev || timeMs < prev) {
        const updated = {
          ...progress,
          bestByTier: { ...progress.bestByTier, [tier]: timeMs },
          baselineByTier: {
            ...progress.baselineByTier,
            ...(!baseline ? { [tier]: timeMs } : {}),
          },
        };
        setProgress(updated);
        saveProgress(updated);
      }
    },
    [progress]
  );

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
          features: measureSync(MEASURE_BIOMETRICS, () => computeFeatures(allStrokesRef.current)),
        });
        setState('complete');
        submitPayload(totalTime, false);
        updateBoardAndProgress(totalTime);
      } else {
        currentIndexRef.current = nextIndex;
        setCurrentIndex(nextIndex);
        glyphStartTimeRef.current = now;
        canvasRef.current?.clear();
      }
    },
    [submitPayload, updateBoardAndProgress, challengeRef]
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

    // Timer via rAF — only push state updates every 250ms to avoid re-rendering at 60fps
    let lastUiUpdate = 0;
    const tickTimer = () => {
      if (!activeRef.current) return;
      const elapsed = performance.now() - startTime;

      // Throttle React state updates to ~24/sec
      if (elapsed - lastUiUpdate >= 42) {
        lastUiUpdate = elapsed;
        setElapsedMs(elapsed);
      }

      if (elapsed >= TIMEOUT_MS) {
        setElapsedMs(TIMEOUT_MS);
        activeRef.current = false;
        setFinalResult({
          totalTimeMs: TIMEOUT_MS,
          timedOut: true,
          digits: [...digitResultsRef.current],
          features: measureSync(MEASURE_BIOMETRICS, () => computeFeatures(allStrokesRef.current)),
        });
        setState('complete');
        return;
      }
      timerRafRef.current = requestAnimationFrame(tickTimer);
    };
    timerRafRef.current = requestAnimationFrame(tickTimer);
  }, [state]);

  const handleNext = useCallback(() => {
    if (!activeRef.current) return;
    const canvas = canvasRef.current?.getCanvas();
    if (!canvas) return;

    const idx = currentIndexRef.current;
    if (!challengeRef.current[idx]) return;

    const now = performance.now();
    const strokes = canvasRef.current?.getStrokes() ?? [];
    const imgData = measureSync('preprocess:image', () => getImageData28x28(canvas));
    const inkPixels = imgData.filter((v) => v > 20).length;
    const INK_THRESHOLD = 15;

    // Client only checks: "did the user draw something?"
    // Server validates correctness via EMNIST inference.
    if (inkPixels >= INK_THRESHOLD) {
      confidenceTimelineRef.current.push({
        t: Math.round(now - startTimeRef.current),
        digitIndex: idx,
        targetConf: 0,
        topDigit: -1,
        topConf: 0,
      });

      allStrokesRef.current.push(...strokes);
      digitResultsRef.current.push({
        target: -1, // Hidden — server decrypts from challengeId
        recognized: -1, // Server validates via EMNIST inference
        confidence: 0,
        timeMs: now - glyphStartTimeRef.current,
        strokes: normalizeStrokes(strokes, startTimeRef.current),
        imageData: imgData,
      });

      advance(now);
    } else {
      // Empty canvas — retry with red flash
      setFlashKey((k) => k + 1);
      canvasRef.current?.clear();
    }
  }, [advance, challengeRef]);

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
    resetVerdict();
    setBoardMode('normal');
    setIsNewPR(false);
    currentIndexRef.current = 0;
    digitResultsRef.current = [];
    allStrokesRef.current = [];
    confidenceTimelineRef.current = [];
    await reloadChallenge();
    setState('idle');
  }, [reloadChallenge, resetVerdict]);

  // Auto-advance to next tier after tier-cleared celebration
  useEffect(() => {
    if (!tierCleared) return;
    const id = setTimeout(async () => {
      const next = getNextTier(progress.currentTier);
      if (!next) return;
      const updated = { ...progress, currentTier: next as Tier };
      setProgress(updated);
      saveProgress(updated);
      setTierCleared(false);
      await handleReset();
    }, 4000);
    return () => clearTimeout(id);
  }, [tierCleared, progress, handleReset]);

  // Auto-reset after a retry (challenge mismatch)
  useEffect(() => {
    if (!retryMsg) return;
    const id = setTimeout(() => handleReset(), 2500);
    return () => clearTimeout(id);
  }, [retryMsg, handleReset]);

  // Auto-post verified token to parent when embedded in iframe
  useEffect(() => {
    if (!argusToken || !isEmbedded()) return;
    const id = setTimeout(() => {
      window.parent.postMessage({ type: MSG_VERIFIED, token: argusToken }, '*');
    }, 1500);
    return () => clearTimeout(id);
  }, [argusToken]);

  // Post error to parent when verdict arrives without a token (failed/timeout)
  useEffect(() => {
    if (!verdict || argusToken || !isEmbedded()) return;
    const id = setTimeout(() => {
      window.parent.postMessage(
        { type: MSG_ERROR, error: 'Verification failed. Please try again.' },
        '*'
      );
    }, 2000);
    return () => clearTimeout(id);
  }, [verdict, argusToken]);

  const remainingMs = TIMEOUT_MS - elapsedMs;
  const timerClass = [
    'timer',
    state === 'active' && 'timer-active',
    state === 'active' && remainingMs <= 5_000 && 'timer-danger',
    state === 'active' && remainingMs > 5_000 && remainingMs <= 10_000 && 'timer-warn',
    state === 'complete' && !finalResult?.timedOut && 'timer-success',
    state === 'complete' && finalResult?.timedOut && 'timer-fail',
  ]
    .filter(Boolean)
    .join(' ');

  const canvasState = state === 'idle' ? 'canvas-idle' : state === 'active' ? 'canvas-active' : '';

  return (
    <div className={`app ${state === 'complete' ? 'app-complete' : ''}`}>
      {flashKey > 0 && <div key={flashKey} className="flash-overlay flash-red" />}
      <header>
        <h1>
          ARGUS <span className="accent">BIO</span>
        </h1>
        <p className="subtitle">Handwriting Biometric Captcha</p>
      </header>

      {sessionError && (
        <div className="loading-panel">
          <p className="loading-msg" style={{ color: 'var(--red, #ef4444)' }}>
            {sessionError}
          </p>
        </div>
      )}

      {!sessionError && state === 'loading' && (
        <div className="loading-panel">
          <div className="spinner" />
          <p className="loading-msg">{LOADING_MSG}</p>
        </div>
      )}

      {!sessionError && state !== 'loading' && (
        <main>
          {state !== 'complete' && (
            <>
              <div className={timerClass}>{formatTime(Math.max(0, TIMEOUT_MS - elapsedMs))}</div>

              <div className="challenge-digits">
                <DotChallenge
                  images={challenge.map((g) => g.image)}
                  imageWidth={imageDims.w}
                  imageHeight={imageDims.h}
                  currentIndex={currentIndex}
                  frameStep={2}
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

          <ActionStack
            state={state}
            retryMsg={retryMsg}
            finalResult={finalResult}
            verdict={verdict}
            argusToken={argusToken}
            returnUrl={returnUrl}
            tier={progress.currentTier}
            boardEntries={boardEntries}
            boardMode={boardMode}
            isNewPR={isNewPR}
            tierCleared={tierCleared}
            onNext={handleNext}
            onErase={handleErase}
            onReset={handleReset}
          />
        </main>
      )}
    </div>
  );
}

function ActionStack({
  state,
  retryMsg,
  finalResult,
  verdict,
  argusToken,
  returnUrl,
  tier,
  boardEntries,
  boardMode,
  isNewPR,
  tierCleared,
  onNext,
  onErase,
  onReset,
}: {
  state: AppState;
  retryMsg: string | null;
  finalResult: FinalResult | null;
  verdict: VerdictResult | null;
  argusToken: string | null;
  returnUrl: string | null;
  tier: Tier;
  boardEntries: BoardEntry[];
  boardMode: 'normal' | 'cleared' | 'shake' | 'off-pace';
  isNewPR: boolean;
  tierCleared: boolean;
  onNext: () => void;
  onErase: () => void;
  onReset: () => void;
}) {
  return (
    <div className="action-stack">
      {(state === 'idle' || state === 'active') && (
        <>
          <button onClick={onNext} className="btn btn-next btn-stack" disabled={state === 'idle'}>
            Next
          </button>
          <button onClick={onErase} className="btn btn-erase btn-stack" disabled={state === 'idle'}>
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
      {state === 'complete' && finalResult && !retryMsg && isEmbedded() && (
        <div className="loading-panel">
          <p
            className="loading-msg"
            style={{
              color: argusToken
                ? 'var(--green, #22c55e)'
                : verdict && !argusToken
                  ? 'var(--red, #ef4444)'
                  : 'var(--text-muted, #9ca3af)',
            }}
          >
            {argusToken ? 'Verified!' : verdict ? 'Try again' : 'Processing...'}
          </p>
        </div>
      )}
      {state === 'complete' && finalResult && !retryMsg && !isEmbedded() && (
        <>
          <ResultDisplay
            totalTimeMs={finalResult.totalTimeMs}
            timedOut={finalResult.timedOut}
            verdict={verdict}
            tier={tier}
            boardEntries={boardEntries}
            boardMode={boardMode}
            isNewPR={isNewPR}
            tierCleared={tierCleared}
          />
          <button onClick={onReset} className="btn btn-primary btn-stack">
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
        </>
      )}
    </div>
  );
}
