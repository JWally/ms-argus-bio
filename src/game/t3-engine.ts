import type { Board, CellState, Player, WinLine } from './t3-types';

const WIN_LINES: [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function checkWinner(board: Board): WinLine | null {
  for (const indices of WIN_LINES) {
    const [a, b, c] = indices;
    if (
      board[a] &&
      board[b] &&
      board[c] &&
      board[a]!.owner === board[b]!.owner &&
      board[a]!.owner === board[c]!.owner
    ) {
      return { indices, winner: board[a]!.owner };
    }
  }
  return null;
}

export function getEmptyCells(board: Board): number[] {
  const empty: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (!board[i]) empty.push(i);
  }
  return empty;
}

export function isDraw(board: Board): boolean {
  return getEmptyCells(board).length === 0;
}

/**
 * Optimal AI move using priority rules (tic-tac-toe is a solved game).
 * Priority: win → block → center → opposite corner → any corner → any side
 */
export function getAIMove(board: Board): number {
  const empty = getEmptyCells(board);
  if (empty.length === 0) return -1;

  // 1. Win: check if AI can win in one move
  for (const cell of empty) {
    if (wouldWin(board, cell, 'ai')) return cell;
  }

  // 2. Block: check if human can win in one move
  for (const cell of empty) {
    if (wouldWin(board, cell, 'human')) return cell;
  }

  // 3. Center
  if (!board[4]) return 4;

  // 4. Opposite corner: if human has a corner, take the opposite
  const cornerPairs: [number, number][] = [
    [0, 8],
    [2, 6],
    [8, 0],
    [6, 2],
  ];
  for (const [humanCorner, opposite] of cornerPairs) {
    if (board[humanCorner]?.owner === 'human' && !board[opposite]) return opposite;
  }

  // 5. Any corner
  const corners = [0, 2, 6, 8];
  for (const c of corners) {
    if (!board[c]) return c;
  }

  // 6. Any side
  const sides = [1, 3, 5, 7];
  for (const s of sides) {
    if (!board[s]) return s;
  }

  return empty[0];
}

function wouldWin(board: Board, cellIndex: number, player: Player): boolean {
  const testBoard = [...board];
  testBoard[cellIndex] = { owner: player, letter: 'X', strokes: [] } as CellState;
  return checkWinner(testBoard) !== null;
}

const LETTERS = 'ABCEFGHIJKLMNPRSTUVWXYZ';

export function randomLetter(): string {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}
