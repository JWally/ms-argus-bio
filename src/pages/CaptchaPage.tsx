import { useState, useCallback, useRef, useEffect } from 'react';
import { getImageData28x28 } from '../ml/preprocess';
import DrawingCanvas, { type CanvasHandle, type Stroke } from '../components/DrawingCanvas';
import ResultDisplay from '../components/ResultDisplay';
import DotChallenge from '../components/DotChallenge';
import {
  computeFeatures,
  normalizeStrokes,
  detectTampering,
  detectCDP,
  type DigitResult,
  type ConfidenceSnapshot,
  type VerdictResult,
} from '../utils/biometrics';
import {
  buildClientImage,
  mask1bitTo8bit,
  CLIENT_IMAGE_WIDTH,
  CLIENT_IMAGE_HEIGHT,
} from '../utils/mask';
import { extractServerKey } from '../utils/crypto';
import { initCrypto, workerDecrypt, workerEncrypt } from '../utils/crypto-worker-client';
import {
  loadProgress,
  saveProgress,
  generateBoard,
  getNextTier,
  type Tier,
  type BoardEntry,
} from '../utils/progression';
import '../App.css';

type AppState = 'loading' | 'idle' | 'active' | 'complete';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const TIMEOUT_MS = 180_000;

// ── Glyph type ──────────────────────────────────────────────────────
// The client no longer knows the character or modelIndex.
// It only receives an image for display; the server validates via EMNIST inference.
interface Glyph {
  /** Base64-encoded 8-bit grayscale image from the server */
  image: string;
}

// ── Fallback for local dev without API ──────────────────────────────
const FALLBACK_LETTERS = [
  'A',
  'C',
  'E',
  'F',
  'H',
  'J',
  'K',
  'M',
  'N',
  'P',
  'R',
  'T',
  'W',
  'X',
  'Y',
];

function generateFallbackChallenge(): Glyph[] {
  const len = 3 + Math.floor(Math.random() * 2); // 3 or 4
  const unique: string[] = [];
  const used = new Set<string>();
  while (unique.length < len - 1) {
    const ch = FALLBACK_LETTERS[Math.floor(Math.random() * FALLBACK_LETTERS.length)];
    if (!used.has(ch)) {
      used.add(ch);
      unique.push(ch);
    }
  }
  const repeatIdx = Math.floor(Math.random() * unique.length);
  const all = [...unique, unique[repeatIdx]];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.map((ch) => ({ image: buildClientImage(ch) }));
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
  const [loadingMsg] = useState('Initializing...');
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
  const challengeRef = useRef<Glyph[]>([]);
  const digitResultsRef = useRef<DigitResult[]>([]);
  const allStrokesRef = useRef<Stroke[]>([]);
  const confidenceTimelineRef = useRef<ConfidenceSnapshot[]>([]);
  const sessionIdRef = useRef<string | null>(
    new URLSearchParams(window.location.search).get('sid')
  );
  const challengeIdRef = useRef<string>('');
  const rawPublicKeyRef = useRef<string>('');
  const serverPubKeyRef = useRef<string>('');
  const [imageDims, setImageDims] = useState({ w: CLIENT_IMAGE_WIDTH, h: CLIENT_IMAGE_HEIGHT });

  /** Fetch a challenge from the server, or fall back to client-side generation.
   *  Also performs ECDH key exchange: sends client pubkey, extracts server pubkey. */
  const fetchChallenge = useCallback(async (): Promise<Glyph[]> => {
    if (!API_URL) return generateFallbackChallenge();
    try {
      // Initialize Worker crypto (or reuse from previous round)
      if (!rawPublicKeyRef.current) {
        const { rawPublicKey } = await initCrypto();
        rawPublicKeyRef.current = rawPublicKey;
      }

      const headers: Record<string, string> = {};
      if (rawPublicKeyRef.current) {
        headers['X-Canvas-Fp'] = rawPublicKeyRef.current;
      }

      const res = await fetch(`${API_URL}/v1/challenge`, { headers });
      const data = await res.json();

      // Extract server's public key appended to challengeId
      const extracted = extractServerKey(data.challengeId as string);
      challengeIdRef.current = extracted.challengeId;
      if (extracted.serverPubKey) {
        serverPubKeyRef.current = extracted.serverPubKey;
      }

      // Decrypt or read plaintext challenge data.
      // Handles both new format (8-bit images) and old format (1-bit masks).
      let images: string[];
      let dims: { w: number; h: number };
      if (data.enc && rawPublicKeyRef.current && extracted.serverPubKey) {
        const decrypted = await workerDecrypt(data.enc as string, extracted.serverPubKey);
        if ('images' in decrypted) {
          images = decrypted.images;
          dims = { w: decrypted.width, h: decrypted.height };
        } else {
          // Old server format — convert 1-bit masks to 8-bit images
          images = decrypted.masks.map((m) =>
            mask1bitTo8bit(m, decrypted.maskWidth, decrypted.maskHeight)
          );
          dims = { w: decrypted.maskWidth, h: decrypted.maskHeight };
        }
      } else if (Array.isArray(data.images)) {
        images = data.images as string[];
        dims = { w: data.width, h: data.height };
      } else {
        // Old plaintext format
        images = (data.masks as string[]).map((m: string) =>
          mask1bitTo8bit(m, data.maskWidth, data.maskHeight)
        );
        dims = { w: data.maskWidth, h: data.maskHeight };
      }
      const result = images.map((image) => ({ image }));
      setImageDims(dims);
      return result;
    } catch {
      challengeIdRef.current = '';
      return generateFallbackChallenge();
    }
  }, []);

  // Fetch server challenge on mount
  useEffect(() => {
    const init = async () => {
      const c = await fetchChallenge();
      setChallenge(c);
      challengeRef.current = c;
      setState('idle');
    };
    init();
  }, [fetchChallenge]);

  const logPayload = useCallback((totalTimeMs: number, timedOut: boolean) => {
    const payload = {
      challengeId: challengeIdRef.current || crypto.randomUUID(),
      // Don't leak expected answers — just send glyph count (all letters)
      challenge: challengeRef.current.map(() => 1),
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
      tamperedApis: [...detectTampering(), ...detectCDP()],
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

    // Encrypt if we have ECDH keys, otherwise fall back to plain JSON
    const canEncrypt = rawPublicKeyRef.current && serverPubKeyRef.current;
    const sendRequest = canEncrypt
      ? workerEncrypt(payload, serverPubKeyRef.current).then((encrypted) =>
          fetch(`${API_URL}/v1/classify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Canvas-Fp': rawPublicKeyRef.current,
            },
            body: encrypted.buffer as ArrayBuffer,
            signal: ctrl.signal,
          })
        )
      : fetch(`${API_URL}/v1/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });

    sendRequest
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

  // Generate tier board + update PR when captcha completes
  const updateBoardAndProgress = useCallback(
    (timeMs: number) => {
      const tier = progress.currentTier;
      const prev = progress.bestByTier[tier];
      const baseline = progress.baselineByTier?.[tier];

      // Generate board anchored to baseline (or current time on first attempt)
      const board = generateBoard(timeMs, tier, progress.playerId, baseline);
      setBoardEntries(board);

      const playerEntry = board.find((e) => e.isPlayer);
      const rank = playerEntry?.rank ?? board.length;
      const beatPR = prev !== undefined && timeMs < prev;

      // Determine display mode (computed BEFORE state updates)
      if (rank === 1 && getNextTier(tier)) {
        setBoardMode('cleared');
        setTierCleared(true);
      } else if (!prev || beatPR) {
        setBoardMode('normal'); // first attempt or new PR
      } else if (rank <= 5) {
        setBoardMode('shake'); // solid but not PR
      } else {
        setBoardMode('off-pace'); // fell below leaders
      }

      setIsNewPR(beatPR);

      // Persist best + baseline
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
          features: computeFeatures(allStrokesRef.current),
        });
        setState('complete');
        logPayload(totalTime, false);
        updateBoardAndProgress(totalTime);
      } else {
        currentIndexRef.current = nextIndex;
        setCurrentIndex(nextIndex);
        glyphStartTimeRef.current = now;
        canvasRef.current?.clear();
      }
    },
    [logPayload, updateBoardAndProgress]
  );

  const handleNext = useCallback(() => {
    if (!activeRef.current) return;
    const canvas = canvasRef.current?.getCanvas();
    if (!canvas) return;

    const idx = currentIndexRef.current;
    if (!challengeRef.current[idx]) return;

    const now = performance.now();
    const strokes = canvasRef.current?.getStrokes() ?? [];
    const imgData = getImageData28x28(canvas);
    const inkPixels = imgData.filter((v) => v > 20).length;
    const INK_THRESHOLD = 15;

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

    // Client only checks: "did the user draw something?"
    // Server validates correctness via EMNIST inference.
    if (inkPixels >= INK_THRESHOLD) {
      advance(now);
    } else {
      // Empty canvas — retry with red flash
      setFlashColor('red');
      setFlashKey((k) => k + 1);
      canvasRef.current?.clear();
    }
  }, [advance]);

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
    setBoardMode('normal');
    setIsNewPR(false);
    currentIndexRef.current = 0;
    digitResultsRef.current = [];
    allStrokesRef.current = [];
    confidenceTimelineRef.current = [];

    const c = await fetchChallenge();
    setChallenge(c);
    challengeRef.current = c;
    setState('idle');
  }, [fetchChallenge]);

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
      {state === 'complete' && finalResult && !retryMsg && (
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
