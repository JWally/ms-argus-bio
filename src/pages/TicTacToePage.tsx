import { useReducer, useEffect, useRef, useCallback, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import { loadLetterModel, predictLetter } from '../ml/letter-model';
import TicTacToeCanvas, { type T3CanvasHandle, CELL_SIZE } from '../components/t3/TicTacToeCanvas';
import GameStatus from '../components/t3/GameStatus';
import GameOverPanel from '../components/t3/GameOverPanel';
import { checkWinner, getEmptyCells, isDraw, getAIMove, randomLetter } from '../game/t3-engine';
import type { GameState, GameAction, Board } from '../game/t3-types';
import type { Stroke } from '../components/DrawingCanvas';
import { computeFeatures, normalizeStrokes, type VerdictResult } from '../utils/biometrics';
import { buildClientMask, CLIENT_MASK_WIDTH, CLIENT_MASK_HEIGHT } from '../utils/mask';
import { renderTo28x28 } from '../ml/preprocess';
import { formatTime } from '../components/Leaderboard';
import '../styles/t3.css';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const RECOGNITION_THRESHOLD = 0.15;
const AI_DELAY_MS = 500;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PHASE_HUMAN_DRAW = 'human-draw';
const T3_LETTERS = 'ACEFHJKMNPRTWXY';
const INFERENCE_STROKE_WIDTH = 4;

// Pre-compute the valid T3 letter indices in the 26-letter alphabet
const T3_VALID_INDICES = new Set(T3_LETTERS.split('').map((ch) => LETTERS.indexOf(ch)));

/** Mask softmax confidences to only T3 pool letters, renormalize */
function maskT3Confidences(raw: number[]): number[] {
  const masked = raw.map((c, i) => (T3_VALID_INDICES.has(i) ? c : 0));
  const sum = masked.reduce((s, c) => s + c, 0);
  return sum > 0 ? masked.map((c) => c / sum) : masked;
}

/** Reusable offscreen canvas for clean white-on-black inference rendering */
let _inferCanvas: HTMLCanvasElement | null = null;

/** Render cell strokes as white-on-black on a clean canvas for model inference.
 *  This avoids feeding the model green strokes (R=34), grid lines, and highlights. */
function renderCleanInference(
  cellStrokes: { x: number; y: number }[][],
  cellOriginX: number,
  cellOriginY: number
): HTMLCanvasElement {
  if (!_inferCanvas) {
    _inferCanvas = document.createElement('canvas');
    _inferCanvas.width = CELL_SIZE;
    _inferCanvas.height = CELL_SIZE;
  }
  const ctx = _inferCanvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CELL_SIZE, CELL_SIZE);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = INFERENCE_STROKE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of cellStrokes) {
    if (stroke.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x - cellOriginX, stroke[0].y - cellOriginY);
    for (let j = 1; j < stroke.length; j++) {
      ctx.lineTo(stroke[j].x - cellOriginX, stroke[j].y - cellOriginY);
    }
    ctx.stroke();
  }
  return _inferCanvas;
}

interface TurnStrokeData {
  cellIndex: number;
  recognizedLetter: string;
  confidence: number;
  allConfidences: number[];
  strokes: Stroke[];
  imageData: number[];
}

/** Generate 5 client-side fallback masks (for local dev without API) */
function generateFallbackMasks(): string[] {
  const used = new Set<string>();
  const masks: string[] = [];
  while (masks.length < 5) {
    const ch = T3_LETTERS[Math.floor(Math.random() * T3_LETTERS.length)];
    if (!used.has(ch)) {
      used.add(ch);
      masks.push(buildClientMask(ch));
    }
  }
  return masks;
}

function initialState(): GameState {
  return {
    phase: 'loading',
    board: Array.from({ length: 9 }, () => null) as Board,
    currentPlayer: 'human',
    currentMaskIndex: 0,
    selectedCell: null,
    winLine: null,
    winner: null,
    message: '',
    turnHistory: [],
    humanTimeMs: 0,
    turnStartMs: null,
    elapsedMs: 0,
  };
}

/** Compute final human elapsed time, snapshotting the current turn */
function finalElapsed(state: GameState): number {
  const now = performance.now();
  return state.humanTimeMs + (state.turnStartMs ? now - state.turnStartMs : 0);
}

function reducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'MODEL_LOADED':
      return { ...state, phase: 'idle', message: '' };

    case 'START_GAME':
      return {
        ...initialState(),
        phase: PHASE_HUMAN_DRAW,
        currentMaskIndex: 0,
        selectedCell: null,
      };

    case 'SELECT_CELL':
      if (state.board[action.cellIndex]) return state;
      return {
        ...state,
        phase: PHASE_HUMAN_DRAW,
        selectedCell: action.cellIndex,
        message: '',
        // Start clock on first cell touch
        turnStartMs: state.turnStartMs ?? performance.now(),
      };

    case 'RECOGNIZE_SUCCESS': {
      const newBoard = [...state.board] as Board;
      newBoard[action.cellIndex] = {
        owner: 'human',
        letter: action.letter,
        strokes: action.strokes,
      };

      // Snapshot human time — clock pauses now
      const elapsed = finalElapsed(state);
      const humanTime = elapsed;
      const turnHistory = [
        ...state.turnHistory,
        { cellIndex: action.cellIndex, player: 'human' as const, letter: action.letter },
      ];

      const win = checkWinner(newBoard);
      if (win) {
        return {
          ...state,
          board: newBoard,
          phase: 'game-over',
          selectedCell: null,
          winLine: win,
          winner: win.winner,
          message: '',
          turnHistory,
          humanTimeMs: humanTime,
          turnStartMs: null,
          elapsedMs: elapsed,
        };
      }

      if (isDraw(newBoard)) {
        return {
          ...state,
          board: newBoard,
          phase: 'game-over',
          selectedCell: null,
          winner: 'draw',
          message: '',
          turnHistory,
          humanTimeMs: humanTime,
          turnStartMs: null,
          elapsedMs: elapsed,
        };
      }

      return {
        ...state,
        board: newBoard,
        phase: 'ai-turn',
        selectedCell: null,
        currentPlayer: 'ai',
        message: '',
        turnHistory,
        humanTimeMs: humanTime,
        turnStartMs: null,
        elapsedMs: elapsed,
      };
    }

    case 'RECOGNIZE_FAIL':
      return { ...state, message: 'Unrecognized — draw more clearly' };

    case 'AI_MOVE': {
      const newBoard = [...state.board] as Board;
      newBoard[action.cellIndex] = {
        owner: 'ai',
        letter: action.letter,
        strokes: [],
      };

      const turnHistory = [
        ...state.turnHistory,
        { cellIndex: action.cellIndex, player: 'ai' as const, letter: action.letter },
      ];

      const win = checkWinner(newBoard);
      if (win) {
        return {
          ...state,
          board: newBoard,
          phase: 'game-over',
          winLine: win,
          winner: win.winner,
          currentPlayer: 'human',
          message: '',
          turnHistory,
          turnStartMs: null,
        };
      }

      if (isDraw(newBoard)) {
        return {
          ...state,
          board: newBoard,
          phase: 'game-over',
          winner: 'draw',
          currentPlayer: 'human',
          message: '',
          turnHistory,
          turnStartMs: null,
        };
      }

      return {
        ...state,
        board: newBoard,
        phase: PHASE_HUMAN_DRAW,
        selectedCell: null,
        currentPlayer: 'human',
        currentMaskIndex: state.currentMaskIndex + 1,
        message: '',
        turnHistory,
        // Resume clock for new human turn
        turnStartMs: performance.now(),
      };
    }

    case 'RESET':
      return {
        ...initialState(),
        phase: PHASE_HUMAN_DRAW,
        currentMaskIndex: 0,
        selectedCell: null,
      };

    default:
      return state;
  }
}

/** Extract 28x28 grayscale image data from cell strokes rendered white-on-black */
function getCellImageData(
  cellStrokes: { x: number; y: number }[][],
  cellOriginX: number,
  cellOriginY: number
): number[] {
  if (cellStrokes.length === 0) return new Array(784).fill(0);
  const cleanCanvas = renderCleanInference(cellStrokes, cellOriginX, cellOriginY);
  const region = { sx: 0, sy: 0, sw: CELL_SIZE, sh: CELL_SIZE };
  const { outCanvas, empty } = renderTo28x28(cleanCanvas, region, 15);
  if (empty) return new Array(784).fill(0);
  const outData = outCanvas.getContext('2d')!.getImageData(0, 0, 28, 28);
  const result: number[] = [];
  for (let i = 0; i < 784; i++) {
    result.push(outData.data[i * 4] / 255);
  }
  return result;
}

const MODAL_DELAY_LOSS = 1200;
const MODAL_DELAY_WIN = 800;

export default function TicTacToePage() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const modelRef = useRef<tf.LayersModel | null>(null);
  const canvasRef = useRef<T3CanvasHandle>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<HTMLDivElement>(null);
  // Biometric data accumulation
  const allStrokesRef = useRef<Stroke[]>([]);
  const turnDataRef = useRef<TurnStrokeData[]>([]);
  const gameStartTimeRef = useRef(0);
  // Server challenge data
  const challengeIdRef = useRef<string>('');
  const [challengeMasks, setChallengeMasks] = useState<string[]>([]);
  const [maskDims, setMaskDims] = useState({ w: CLIENT_MASK_WIDTH, h: CLIENT_MASK_HEIGHT });

  /** Fetch a T3 challenge from the server, or fall back to client-side generation.
   *  Returns the data; caller is responsible for updating state. */
  const fetchT3Challenge = useCallback(async () => {
    const fallback = {
      id: '',
      masks: generateFallbackMasks(),
      dims: { w: CLIENT_MASK_WIDTH, h: CLIENT_MASK_HEIGHT },
    };
    if (!API_URL) return fallback;
    try {
      const res = await fetch(`${API_URL}/v1/challenge?mode=t3`);
      const data = await res.json();
      return {
        id: data.challengeId as string,
        masks: data.masks as string[],
        dims: { w: data.maskWidth as number, h: data.maskHeight as number },
      };
    } catch {
      return fallback;
    }
  }, []);

  /** Fetch challenge and apply to state */
  const applyChallenge = useCallback(async () => {
    const c = await fetchT3Challenge();
    challengeIdRef.current = c.id;
    setChallengeMasks(c.masks);
    setMaskDims(c.dims);
  }, [fetchT3Challenge]);

  // Load model + fetch challenge on mount
  useEffect(() => {
    Promise.all([loadLetterModel(), fetchT3Challenge()]).then(([model, challenge]) => {
      modelRef.current = model;
      challengeIdRef.current = challenge.id;
      setChallengeMasks(challenge.masks);
      setMaskDims(challenge.dims);
      dispatch({ type: 'MODEL_LOADED' });
    });
  }, [fetchT3Challenge]);

  // Speed-chess timer: rAF only during human turns — writes to DOM directly
  useEffect(() => {
    if (state.turnStartMs === null) return;

    const base = state.humanTimeMs;
    const start = state.turnStartMs;
    const tick = () => {
      const elapsed = base + (performance.now() - start);
      if (timerRef.current) timerRef.current.textContent = formatTime(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state.turnStartMs, state.humanTimeMs]);

  // AI turn: delayed move
  useEffect(() => {
    if (state.phase !== 'ai-turn') return;

    const timer = setTimeout(() => {
      const cellIndex = getAIMove(state.board);
      if (cellIndex >= 0) {
        dispatch({ type: 'AI_MOVE', cellIndex, letter: randomLetter() });
      }
    }, AI_DELAY_MS);

    return () => clearTimeout(timer);
  }, [state.phase, state.board]);

  // Send biometric payload when game ends
  const sendBiometricPayload = useCallback(() => {
    if (!API_URL) return;

    const allStrokes = allStrokesRef.current;
    const turnData = turnDataRef.current;
    const inputType = canvasRef.current?.getInputType() ?? 'unknown';

    const payload = {
      challengeId: challengeIdRef.current || crypto.randomUUID(),
      // Don't leak expected answers — just send glyph types (all letters for T3)
      challenge: turnData.map(() => 1),
      timestamp: Date.now(),
      completionTimeMs: state.elapsedMs,
      passed: true, // all human letters were recognized — win/loss is irrelevant
      digits: turnData.map((t) => ({
        target: -1, // Hidden — server decrypts from challengeId
        recognized: LETTERS.indexOf(t.recognizedLetter),
        confidence: t.confidence,
        allConfidences: t.allConfidences,
        timeMs: 0,
        strokes: normalizeStrokes(t.strokes, gameStartTimeRef.current, CELL_SIZE),
        imageData: t.imageData,
      })),
      confidenceTimeline: [],
      inputType,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      features: computeFeatures(allStrokes),
      gameMode: 't3',
    };

    // eslint-disable-next-line no-console
    console.log('[ARGUS T3] Biometric Payload', payload);

    fetch(`${API_URL}/v1/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json())
      .then((v) => {
        // eslint-disable-next-line no-console
        console.log('[ARGUS T3] Verdict', v);
        if (v.retry) {
          setRetryMsg(v.message || 'Incorrect letters. Try again!');
          return;
        }
        if (v.verdict) setVerdict(v as VerdictResult);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[ARGUS T3] Classification error', err);
      });
  }, [state.elapsedMs]);

  // Trigger payload send on game-over + delayed modal
  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current !== 'game-over' && state.phase === 'game-over') {
      sendBiometricPayload();
      const delay = state.winner === 'human' ? MODAL_DELAY_WIN : MODAL_DELAY_LOSS;
      const timer = setTimeout(() => setShowModal(true), delay);
      prevPhaseRef.current = state.phase;
      return () => clearTimeout(timer);
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase, state.winner, sendBiometricPayload]);

  // ── Recognition helpers ─────────────────────────────────────────────

  /** Try to recognize the current cell — recognizability-only.
   *  Client has NO knowledge of the target letter — it only checks "is this a letter?"
   *  Server validates correctness by decrypting the challengeId.
   *
   *  Uses a clean white-on-black offscreen canvas for inference (not the game canvas)
   *  because the game canvas has green strokes (R=34 — model sees 13% brightness),
   *  grid lines, and cell highlights that confuse the model. */
  const tryRecognize = useCallback((): {
    cellIndex: number;
    letter: string;
    confidence: number;
    allConfidences: number[];
  } | null => {
    if (state.phase !== PHASE_HUMAN_DRAW || state.selectedCell === null || !modelRef.current)
      return null;

    const cellStrokes = canvasRef.current?.getCellStrokes();
    if (!cellStrokes || cellStrokes.length === 0) return null;

    const cellIndex = state.selectedCell;
    const col = cellIndex % 3;
    const row = Math.floor(cellIndex / 3);

    // Render strokes white-on-black on a clean canvas — no grid, no green
    const cleanCanvas = renderCleanInference(cellStrokes, col * CELL_SIZE, row * CELL_SIZE);

    const result = predictLetter(modelRef.current, cleanCanvas, {
      x: 0,
      y: 0,
      w: CELL_SIZE,
      h: CELL_SIZE,
    });

    // Mask softmax to only T3 pool letters (removes L, I, O, D, etc.)
    const masked = maskT3Confidences(result.allConfidences);
    const topIdx = masked.indexOf(Math.max(...masked));
    const letter = LETTERS[topIdx];
    const confidence = masked[topIdx];

    // eslint-disable-next-line no-console
    console.log(
      `[T3] Raw top: ${result.letter} (${(result.confidence * 100).toFixed(1)}%) → Masked top: ${letter} (${(confidence * 100).toFixed(1)}%)`
    );

    // Recognizability-only: accept any T3 letter at threshold.
    if (confidence >= RECOGNITION_THRESHOLD) {
      return { cellIndex, letter, confidence, allConfidences: masked };
    }
    return null;
  }, [state.phase, state.selectedCell]);

  /** Collect rich strokes + imageData for the current cell turn */
  const collectTurnData = useCallback(
    (cellIndex: number, recognizedLetter: string, confidence: number, allConfs: number[]) => {
      const richStrokes = canvasRef.current?.getRichStrokes() ?? [];
      allStrokesRef.current.push(...richStrokes);

      const cellStrokes = canvasRef.current?.getCellStrokes() ?? [];
      const col = cellIndex % 3;
      const row = Math.floor(cellIndex / 3);
      const imageData = getCellImageData(cellStrokes, col * CELL_SIZE, row * CELL_SIZE);

      turnDataRef.current.push({
        cellIndex,
        recognizedLetter,
        confidence,
        allConfidences: allConfs,
        strokes: richStrokes,
        imageData,
      });
    },
    []
  );

  /** Submit — dispatches FAIL if recognition doesn't pass */
  const handleSubmit = useCallback(() => {
    const result = tryRecognize();
    if (result) {
      collectTurnData(result.cellIndex, result.letter, result.confidence, result.allConfidences);
      const strokes = canvasRef.current?.getCellStrokes() ?? [];
      dispatch({ type: 'RECOGNIZE_SUCCESS', ...result, strokes });
    } else if (state.selectedCell !== null) {
      dispatch({ type: 'RECOGNIZE_FAIL' });
      // Flash red and clear the cell
      setFlashKey((k) => k + 1);
      canvasRef.current?.dissolveCell();
    }
  }, [tryRecognize, state.selectedCell, collectTurnData]);

  /** No-op — user must click the DONE button to submit their letter */
  const handleStrokeEnd = useCallback(() => {}, []);

  const handleCellSelect = useCallback(
    (cellIndex: number) => {
      if (state.phase === 'idle') {
        gameStartTimeRef.current = performance.now();
        dispatch({ type: 'START_GAME' });
        return;
      }
      if (state.phase === PHASE_HUMAN_DRAW && cellIndex >= 0) {
        dispatch({ type: 'SELECT_CELL', cellIndex });
      }
    },
    [state.phase]
  );

  const handlePlayAgain = useCallback(async () => {
    canvasRef.current?.clearCell(-1); // clear all
    allStrokesRef.current = [];
    turnDataRef.current = [];
    setVerdict(null);
    setShowModal(false);
    setRetryMsg(null);
    // Fetch a fresh challenge for the new game
    await applyChallenge();
    dispatch({ type: 'RESET' });
  }, [applyChallenge]);

  // Auto-reset after a retry (server challenge mismatch)
  useEffect(() => {
    if (!retryMsg) return;
    const id = setTimeout(() => handlePlayAgain(), 3000);
    return () => clearTimeout(id);
  }, [retryMsg, handlePlayAgain]);

  const isPlaying = state.phase !== 'idle' && state.phase !== 'loading';
  const canvasClass = state.phase === PHASE_HUMAN_DRAW ? 't3-canvas-active' : '';

  const timerClass =
    state.turnStartMs !== null
      ? 'timer timer-active'
      : state.phase === 'game-over'
        ? `timer ${state.winner === 'human' ? 'timer-success' : 'timer-fail'}`
        : 'timer';

  const currentMask = challengeMasks[state.currentMaskIndex] ?? '';

  return (
    <div className={`app${isPlaying ? ' t3-compact' : ''}`}>
      {flashKey > 0 && <div key={flashKey} className="flash-overlay flash-red" />}
      <header>
        <h1>
          ARGUS <span className="accent">T3</span>
        </h1>
        <p className="subtitle">Tic-Tac-Toe with Handwritten Letters</p>
      </header>

      <div className="t3-page">
        <GameStatus
          phase={state.phase}
          mask={currentMask}
          maskWidth={maskDims.w}
          maskHeight={maskDims.h}
          message={state.message}
          board={state.board}
        />

        <div ref={timerRef} className={timerClass}>
          {formatTime(state.elapsedMs)}
        </div>

        <div className={canvasClass}>
          <TicTacToeCanvas
            ref={canvasRef}
            board={state.board}
            selectedCell={state.selectedCell}
            winLine={state.winLine}
            winner={state.winner}
            phase={state.phase}
            onCellSelect={handleCellSelect}
            onStrokeEnd={handleStrokeEnd}
          />
        </div>

        <div className="t3-actions">
          {state.phase !== 'game-over' && state.phase !== 'idle' && state.phase !== 'loading' && (
            <button
              className="t3-submit-btn"
              onClick={handleSubmit}
              disabled={state.phase !== PHASE_HUMAN_DRAW || state.selectedCell === null}
              style={{ visibility: state.phase === 'ai-turn' ? 'hidden' : 'visible' }}
            >
              NEXT
            </button>
          )}

          {getEmptyCells(state.board).length < 9 && state.phase !== 'game-over' && (
            <button onClick={handlePlayAgain} className="btn btn-secondary btn-stack">
              Reset
            </button>
          )}
        </div>
      </div>

      {state.phase === 'game-over' && retryMsg && (
        <div className="t3-modal-overlay">
          <div className="t3-modal">
            <div className="t3-result t3-result-lose">
              <div className="t3-result-header">&#x21bb;</div>
              <p className="t3-status-text">{retryMsg}</p>
              <p className="t3-status-text" style={{ opacity: 0.5 }}>
                Resetting automatically&hellip;
              </p>
            </div>
          </div>
        </div>
      )}

      {state.phase === 'game-over' && showModal && !retryMsg && (
        <div className="t3-modal-overlay">
          <div className={`t3-modal${state.winner === 'human' ? ' t3-modal-celebrate' : ''}`}>
            <GameOverPanel
              winner={state.winner}
              elapsedMs={state.elapsedMs}
              verdict={verdict}
              onPlayAgain={handlePlayAgain}
            />
          </div>
        </div>
      )}
    </div>
  );
}
