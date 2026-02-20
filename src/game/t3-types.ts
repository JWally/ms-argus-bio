export type Player = 'human' | 'ai';

export interface CellState {
  owner: Player;
  letter: string;
  /** Stored strokes for human cells (to replay on canvas) */
  strokes: { x: number; y: number }[][];
}

export type Board = (CellState | null)[];

export type GamePhase =
  | 'loading'
  | 'idle'
  | 'human-draw'
  | 'human-recognize'
  | 'ai-turn'
  | 'game-over';

export interface WinLine {
  indices: [number, number, number];
  winner: Player;
}

export interface TurnRecord {
  cellIndex: number;
  player: Player;
  letter: string;
}

export interface GameState {
  phase: GamePhase;
  board: Board;
  currentPlayer: Player;
  /** Index into the server-provided masks array for the current human turn */
  currentMaskIndex: number;
  selectedCell: number | null;
  winLine: WinLine | null;
  winner: Player | 'draw' | 'timeout' | null;
  message: string;
  turnHistory: TurnRecord[];
  /** Accumulated human thinking time from completed turns */
  humanTimeMs: number;
  /** When the current human turn started (null = AI's turn or not started) */
  turnStartMs: number | null;
  /** Display value — only counts human time (speed-chess style) */
  elapsedMs: number;
}

export type GameAction =
  | { type: 'MODEL_LOADED' }
  | { type: 'START_GAME'; aiFirst?: boolean }
  | { type: 'SELECT_CELL'; cellIndex: number }
  | {
      type: 'RECOGNIZE_SUCCESS';
      cellIndex: number;
      letter: string;
      strokes: { x: number; y: number }[][];
    }
  | { type: 'RECOGNIZE_FAIL' }
  | { type: 'AI_MOVE'; cellIndex: number; letter: string }
  | { type: 'TIMEOUT'; elapsedMs: number }
  | { type: 'RESET'; aiFirst?: boolean };
