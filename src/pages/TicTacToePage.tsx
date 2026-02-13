import { useReducer, useEffect, useRef, useCallback } from 'react';
import * as tf from '@tensorflow/tfjs';
import { loadLetterModel, predictLetter } from '../ml/letter-model';
import TicTacToeCanvas, { type T3CanvasHandle, CELL_SIZE } from '../components/t3/TicTacToeCanvas';
import GameStatus from '../components/t3/GameStatus';
import GameOverPanel from '../components/t3/GameOverPanel';
import { checkWinner, getEmptyCells, isDraw, getAIMove, randomLetter } from '../game/t3-engine';
import type { GameState, GameAction, Board } from '../game/t3-types';
import { formatTime } from '../components/Leaderboard';
import '../styles/t3.css';

const CONFIDENCE_THRESHOLD = 0.6;
const TARGET_CONFIDENCE_THRESHOLD = 0.3;
const AI_DELAY_MS = 500;
const AUTO_SUBMIT_MS = 2500;

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
        phase: 'human-draw',
        targetLetter: randomLetter(),
        selectedCell: null,
      };

    case 'SELECT_CELL':
      if (state.board[action.cellIndex]) return state;
      return {
        ...state,
        phase: 'human-draw',
        selectedCell: action.cellIndex,
        message: '',
        // Start clock on first cell touch
        turnStartMs: state.turnStartMs ?? performance.now(),
      };

    case 'TICK':
      return {
        ...state,
        elapsedMs: state.humanTimeMs + (state.turnStartMs ? action.now - state.turnStartMs : 0),
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
        phase: 'human-draw',
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
        phase: 'human-draw',
        targetLetter: randomLetter(),
        selectedCell: null,
      };

    default:
      return state;
  }
}

export default function TicTacToePage() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const modelRef = useRef<tf.LayersModel | null>(null);
  const canvasRef = useRef<T3CanvasHandle>(null);
  const autoSubmitTimerRef = useRef(0);
  const rafRef = useRef(0);

  // Load model on mount
  useEffect(() => {
    loadLetterModel().then((model) => {
      modelRef.current = model;
      dispatch({ type: 'MODEL_LOADED' });
    });
  }, []);

  // Speed-chess timer: rAF only during human turns
  useEffect(() => {
    if (state.turnStartMs === null) return;

    const tick = () => {
      dispatch({ type: 'TICK', now: performance.now() });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state.turnStartMs]);

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

  // ── Recognition helpers ─────────────────────────────────────────────

  /** Try to recognize the current cell — returns match or null */
  const tryRecognize = useCallback((): { cellIndex: number; letter: string } | null => {
    if (state.phase !== 'human-draw' || state.selectedCell === null || !modelRef.current)
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
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
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
      return { cellIndex, letter: state.targetLetter };
    }
    return null;
  }, [state.phase, state.selectedCell, state.targetLetter]);

  /** Force submit — dispatches FAIL if recognition doesn't pass */
  const handleSubmit = useCallback(() => {
    clearTimeout(autoSubmitTimerRef.current);
    const result = tryRecognize();
    if (result) {
      const strokes = canvasRef.current?.getCellStrokes() ?? [];
      dispatch({ type: 'RECOGNIZE_SUCCESS', ...result, strokes });
    } else if (state.selectedCell !== null) {
      dispatch({ type: 'RECOGNIZE_FAIL' });
      canvasRef.current?.dissolveCell();
    }
  }, [tryRecognize, state.selectedCell]);

  /** Called on every stroke end — tries instant recognition, falls back to timer */
  const handleStrokeEnd = useCallback(() => {
    if (state.phase !== 'human-draw') return;

    // Try instant recognition on each stroke end
    const result = tryRecognize();
    if (result) {
      clearTimeout(autoSubmitTimerRef.current);
      const strokes = canvasRef.current?.getCellStrokes() ?? [];
      dispatch({ type: 'RECOGNIZE_SUCCESS', ...result, strokes });
      return;
    }

    // Not recognized yet — fallback timer for "try again" feedback
    clearTimeout(autoSubmitTimerRef.current);
    autoSubmitTimerRef.current = window.setTimeout(() => {
      handleSubmit();
    }, AUTO_SUBMIT_MS);
  }, [state.phase, tryRecognize, handleSubmit]);

  const handleCellSelect = useCallback(
    (cellIndex: number) => {
      if (state.phase === 'idle') {
        dispatch({ type: 'START_GAME' });
        return;
      }
      if (state.phase === 'human-draw' && cellIndex >= 0) {
        dispatch({ type: 'SELECT_CELL', cellIndex });
      }
    },
    [state.phase]
  );

  const handlePlayAgain = useCallback(() => {
    canvasRef.current?.clearCell(-1); // clear all
    dispatch({ type: 'RESET' });
  }, []);

  const canvasClass = state.phase === 'human-draw' ? 't3-canvas-active' : '';

  const timerClass =
    state.turnStartMs !== null
      ? 'timer timer-active'
      : state.phase === 'game-over'
        ? `timer ${state.winner === 'human' ? 'timer-success' : 'timer-fail'}`
        : 'timer';

  return (
    <div className="app">
      <header>
        <h1>
          ARGUS <span className="accent">T3</span>
        </h1>
        <p className="subtitle">Tic-Tac-Toe with Handwritten Letters</p>
      </header>

      <div className="t3-page">
        <GameStatus phase={state.phase} targetLetter={state.targetLetter} message={state.message} />

        <div className={timerClass}>{formatTime(state.elapsedMs)}</div>

        <div className={canvasClass}>
          <TicTacToeCanvas
            ref={canvasRef}
            board={state.board}
            selectedCell={state.selectedCell}
            winLine={state.winLine}
            phase={state.phase}
            onCellSelect={handleCellSelect}
            onStrokeEnd={handleStrokeEnd}
          />
        </div>

        <div className="t3-actions">
          {(state.phase === 'human-draw' || state.phase === 'ai-turn') && (
            <div
              className={`t3-turn ${state.phase === 'ai-turn' ? 't3-turn-ai' : 't3-turn-human'}`}
            >
              {state.phase === 'ai-turn' ? "AI'S TURN" : 'YOUR TURN'}
            </div>
          )}

          {state.phase === 'game-over' && (
            <GameOverPanel
              winner={state.winner}
              elapsedMs={state.elapsedMs}
              onPlayAgain={handlePlayAgain}
            />
          )}

          {getEmptyCells(state.board).length < 9 && state.phase !== 'game-over' && (
            <button onClick={handlePlayAgain} className="btn btn-secondary btn-stack">
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
