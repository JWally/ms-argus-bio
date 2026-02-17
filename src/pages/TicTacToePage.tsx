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
import { renderTo28x28 } from '../ml/preprocess';
import { formatTime } from '../components/Leaderboard';
import '../styles/t3.css';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const CONFIDENCE_THRESHOLD = 0.6;
const TARGET_CONFIDENCE_THRESHOLD = 0.3;
const AI_DELAY_MS = 500;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PHASE_HUMAN_DRAW = 'human-draw';

interface TurnStrokeData {
  cellIndex: number;
  targetLetter: string;
  recognizedLetter: string;
  confidence: number;
  strokes: Stroke[];
  imageData: number[];
}

function initialState(): GameState {
  return {
    phase: 'loading',
    board: Array.from({ length: 9 }, () => null) as Board,
    currentPlayer: 'human',
    targetLetter: randomLetter(),
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
        targetLetter: randomLetter(),
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
      return { ...state, message: 'Try again — draw more clearly' };

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
          // No human time added — AI's move
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
        targetLetter: randomLetter(),
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
        targetLetter: randomLetter(),
        selectedCell: null,
      };

    default:
      return state;
  }
}

/** Extract 28x28 grayscale image data from a cell region of the canvas */
function getCellImageData(canvas: HTMLCanvasElement, cellIndex: number): number[] {
  const col = cellIndex % 3;
  const row = Math.floor(cellIndex / 3);
  const region = { sx: col * CELL_SIZE, sy: row * CELL_SIZE, sw: CELL_SIZE, sh: CELL_SIZE };
  const { outCanvas, empty } = renderTo28x28(canvas, region, 15);
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
  const modelRef = useRef<tf.LayersModel | null>(null);
  const canvasRef = useRef<T3CanvasHandle>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<HTMLDivElement>(null);
  // Biometric data accumulation
  const allStrokesRef = useRef<Stroke[]>([]);
  const turnDataRef = useRef<TurnStrokeData[]>([]);
  const gameStartTimeRef = useRef(0);

  // Load model on mount
  useEffect(() => {
    loadLetterModel().then((model) => {
      modelRef.current = model;
      dispatch({ type: 'MODEL_LOADED' });
    });
  }, []);

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
    const startTime = gameStartTimeRef.current;
    const inputType = canvasRef.current?.getInputType() ?? 'unknown';

    const payload = {
      challengeId: crypto.randomUUID(),
      challenge: turnData.map((t) => LETTERS.indexOf(t.targetLetter)),
      timestamp: Date.now(),
      completionTimeMs: state.elapsedMs,
      passed: true, // all human letters were recognized — win/loss is irrelevant
      digits: turnData.map((t) => ({
        target: LETTERS.indexOf(t.targetLetter),
        recognized: LETTERS.indexOf(t.recognizedLetter),
        confidence: t.confidence,
        timeMs: 0,
        strokes: normalizeStrokes(t.strokes, startTime, CELL_SIZE),
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
        setVerdict(v as VerdictResult);
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

  /** Try to recognize the current cell — returns match or null */
  const tryRecognize = useCallback((): {
    cellIndex: number;
    letter: string;
    confidence: number;
  } | null => {
    if (state.phase !== PHASE_HUMAN_DRAW || state.selectedCell === null || !modelRef.current)
      return null;

    const canvas = canvasRef.current?.getCanvas();
    if (!canvas) return null;

    const cellIndex = state.selectedCell;
    const col = cellIndex % 3;
    const row = Math.floor(cellIndex / 3);

    const { letter, confidence, allConfidences } = predictLetter(modelRef.current, canvas, {
      x: col * CELL_SIZE,
      y: row * CELL_SIZE,
      w: CELL_SIZE,
      h: CELL_SIZE,
    });

    // Targeted verification: check confidence of the specific letter we asked for
    const targetIdx = LETTERS.indexOf(state.targetLetter);
    const targetConf = allConfidences[targetIdx];

    // eslint-disable-next-line no-console
    console.log(
      `[T3] Top: ${letter} (${(confidence * 100).toFixed(1)}%) | ` +
        `Target ${state.targetLetter}: ${(targetConf * 100).toFixed(1)}%`
    );

    // Accept if: argmax matches with high confidence, OR target letter has reasonable confidence
    if (
      (letter === state.targetLetter && confidence >= CONFIDENCE_THRESHOLD) ||
      targetConf >= TARGET_CONFIDENCE_THRESHOLD
    ) {
      return { cellIndex, letter: state.targetLetter, confidence: targetConf };
    }
    return null;
  }, [state.phase, state.selectedCell, state.targetLetter]);

  /** Collect rich strokes + imageData for the current cell turn */
  const collectTurnData = useCallback(
    (cellIndex: number, targetLetter: string, recognizedLetter: string, confidence: number) => {
      const richStrokes = canvasRef.current?.getRichStrokes() ?? [];
      allStrokesRef.current.push(...richStrokes);

      const canvas = canvasRef.current?.getCanvas();
      const imageData = canvas ? getCellImageData(canvas, cellIndex) : new Array(784).fill(0);

      turnDataRef.current.push({
        cellIndex,
        targetLetter,
        recognizedLetter,
        confidence,
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
      collectTurnData(result.cellIndex, state.targetLetter, result.letter, result.confidence);
      const strokes = canvasRef.current?.getCellStrokes() ?? [];
      dispatch({ type: 'RECOGNIZE_SUCCESS', ...result, strokes });
    } else if (state.selectedCell !== null) {
      dispatch({ type: 'RECOGNIZE_FAIL' });
      canvasRef.current?.dissolveCell();
    }
  }, [tryRecognize, state.selectedCell, state.targetLetter, collectTurnData]);

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

  const handlePlayAgain = useCallback(() => {
    canvasRef.current?.clearCell(-1); // clear all
    allStrokesRef.current = [];
    turnDataRef.current = [];
    setVerdict(null);
    setShowModal(false);
    dispatch({ type: 'RESET' });
  }, []);

  const isPlaying = state.phase !== 'idle' && state.phase !== 'loading';
  const canvasClass = state.phase === PHASE_HUMAN_DRAW ? 't3-canvas-active' : '';

  const timerClass =
    state.turnStartMs !== null
      ? 'timer timer-active'
      : state.phase === 'game-over'
        ? `timer ${state.winner === 'human' ? 'timer-success' : 'timer-fail'}`
        : 'timer';

  return (
    <div className={`app${isPlaying ? ' t3-compact' : ''}`}>
      <header>
        <h1>
          ARGUS <span className="accent">T3</span>
        </h1>
        <p className="subtitle">Tic-Tac-Toe with Handwritten Letters</p>
      </header>

      <div className="t3-page">
        <GameStatus
          phase={state.phase}
          targetLetter={state.targetLetter}
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
          {state.phase === PHASE_HUMAN_DRAW && (
            <button
              className="t3-submit-btn"
              onClick={handleSubmit}
              disabled={state.selectedCell === null}
            >
              DONE
            </button>
          )}

          {state.phase === 'ai-turn' && <div className="t3-turn t3-turn-ai">AI&apos;S TURN</div>}

          {getEmptyCells(state.board).length < 9 && state.phase !== 'game-over' && (
            <button onClick={handlePlayAgain} className="btn btn-secondary btn-stack">
              Reset
            </button>
          )}
        </div>
      </div>

      {state.phase === 'game-over' && showModal && (
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
