import { forwardRef, useRef, useImperativeHandle, useEffect, useCallback } from 'react';
import type { Board, WinLine, GamePhase, Player } from '../../game/t3-types';
import type { Stroke, StrokePoint } from '../DrawingCanvas';
import { isCoalescedSpoofed } from '../../utils/pointer-utils';

/** Internal resolution of the canvas: 3 cells x CELL_SIZE */
const CELL_SIZE = 140;
const CANVAS_SIZE = CELL_SIZE * 3; // 420
const GRID_LINE_WIDTH = 3;
const STROKE_LINE_WIDTH = 12;
const INSET = 5; // drawing tolerance inset from cell edges
const FONT = 'Orbitron, system-ui, sans-serif';
const MORPH_MS = 600;
const DISSOLVE_MS = 400;

export interface T3CanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
  /** Get strokes drawn in the currently active cell (render-only {x,y}) */
  getCellStrokes: () => { x: number; y: number }[][];
  /** Get rich biometric strokes for the current cell */
  getRichStrokes: () => Stroke[];
  /** Get pointer input type (mouse/touch/pen) */
  getInputType: () => string;
  clearCell: (cellIndex: number) => void;
  /** Fade out current strokes over DISSOLVE_MS, then clear */
  dissolveCell: () => void;
}

interface Props {
  board: Board;
  selectedCell: number | null;
  winLine: WinLine | null;
  winner: Player | 'draw' | 'timeout' | null;
  phase: GamePhase;
  onCellSelect: (cellIndex: number) => void;
  onStrokeEnd: () => void;
}

type Point = { x: number; y: number };

/** Convert cell index (0-8) to pixel origin {x, y} */
function cellOrigin(index: number): Point {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: col * CELL_SIZE, y: row * CELL_SIZE };
}

/** Get cell center in canvas coordinates */
function cellCenter(index: number): Point {
  const { x, y } = cellOrigin(index);
  return { x: x + CELL_SIZE / 2, y: y + CELL_SIZE / 2 };
}

/** Read a CSS variable from :root, with fallback */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Draw a series of stroke paths on the context */
function drawStrokePaths(ctx: CanvasRenderingContext2D, strokes: Point[][]): void {
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let j = 1; j < stroke.length; j++) {
      ctx.lineTo(stroke[j].x, stroke[j].y);
    }
    ctx.stroke();
  }
}

/** Check if a point is within a cell (with INSET tolerance) */
function isPointInCell(pos: Point, cellIdx: number): boolean {
  const origin = cellOrigin(cellIdx);
  return (
    pos.x >= origin.x - INSET &&
    pos.x <= origin.x + CELL_SIZE + INSET &&
    pos.y >= origin.y - INSET &&
    pos.y <= origin.y + CELL_SIZE + INSET
  );
}

// ── Render sub-routines ──────────────────────────────────────────────

function renderGrid(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.strokeStyle = cssVar('--border', '#2a2a3e');
  ctx.lineWidth = GRID_LINE_WIDTH;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_SIZE, 0);
    ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_SIZE);
    ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE);
    ctx.stroke();
  }
}

function renderPlacedMarks(ctx: CanvasRenderingContext2D, board: Board): void {
  for (let i = 0; i < 9; i++) {
    const cell = board[i];
    if (!cell) continue;
    const origin = cellOrigin(i);
    const center = cellCenter(i);

    if (cell.owner === 'human') {
      // Show the user's actual handwritten strokes — green
      ctx.save();
      ctx.beginPath();
      ctx.rect(origin.x, origin.y, CELL_SIZE, CELL_SIZE);
      ctx.clip();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = STROKE_LINE_WIDTH;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(34, 197, 94, 0.3)';
      ctx.shadowBlur = 6;
      drawStrokePaths(ctx, cell.strokes);
      ctx.restore();
    } else {
      // AI letters — red
      ctx.save();
      ctx.font = `900 ${CELL_SIZE * 0.65}px ${FONT}`;
      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = 'rgba(239, 68, 68, 0.4)';
      ctx.shadowBlur = 8;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cell.letter, center.x, center.y + 4);
      ctx.restore();
    }
  }
}

function renderActiveCell(ctx: CanvasRenderingContext2D, cellIdx: number): void {
  const origin = cellOrigin(cellIdx);
  ctx.save();
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
  ctx.shadowBlur = 12;
  ctx.strokeRect(origin.x + INSET, origin.y + INSET, CELL_SIZE - INSET * 2, CELL_SIZE - INSET * 2);
  ctx.restore();
}

function renderLiveStrokes(
  ctx: CanvasRenderingContext2D,
  cellIdx: number,
  cellStrokes: Point[][],
  currentStroke: Point[] | null,
  alpha: number = 1
): void {
  const origin = cellOrigin(cellIdx);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(origin.x, origin.y, CELL_SIZE, CELL_SIZE);
  ctx.clip();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = STROKE_LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawStrokePaths(ctx, cellStrokes);

  if (currentStroke && currentStroke.length > 0) {
    drawStrokePaths(ctx, [currentStroke]);
  }
  ctx.restore();
}

function renderWinLine(ctx: CanvasRenderingContext2D, winLine: WinLine): void {
  const start = cellCenter(winLine.indices[0]);
  const end = cellCenter(winLine.indices[2]);
  ctx.save();
  ctx.strokeStyle = cssVar('--success', '#22c55e');
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(34, 197, 94, 0.6)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

function renderIdleOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 20px ${FONT}`;
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('Tap to Start', CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 14);
  ctx.font = `400 14px ${FONT}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('You draw, AI thinks', CANVAS_SIZE / 2, CANVAS_SIZE / 2 + 14);
  ctx.restore();
}

// ── Celebration particles ─────────────────────────────────────────────

const CELEBRATION_MS = 1000;
const PARTICLE_COUNT = 24;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
}

function spawnParticles(winLine: WinLine): Particle[] {
  const particles: Particle[] = [];
  for (const idx of winLine.indices) {
    const center = cellCenter(idx);
    for (let i = 0; i < PARTICLE_COUNT / 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 80;
      particles.push({
        x: center.x,
        y: center.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 2 + Math.random() * 4,
        alpha: 1,
      });
    }
  }
  return particles;
}

function renderCelebration(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  progress: number,
  winLine: WinLine
): void {
  // Glow pulse on win line
  const start = cellCenter(winLine.indices[0]);
  const end = cellCenter(winLine.indices[2]);
  const pulse = 1 + 0.4 * Math.sin(progress * Math.PI * 4);
  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 6 * pulse;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(34, 197, 94, 0.8)';
  ctx.shadowBlur = 16 + 12 * pulse;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();

  // Particles
  for (const p of particles) {
    const t = progress;
    const px = p.x + p.vx * t;
    const py = p.y + p.vy * t;
    const alpha = p.alpha * (1 - progress);
    const radius = p.radius * (1 + progress * 0.5);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#22c55e';
    ctx.shadowColor = 'rgba(34, 197, 94, 0.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Component ────────────────────────────────────────────────────────

const DRAW_PHASES: GamePhase[] = ['human-draw', 'human-recognize'];

const TicTacToeCanvas = forwardRef<T3CanvasHandle, Props>(
  ({ board, selectedCell, winLine, winner, phase, onCellSelect, onStrokeEnd }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cellStrokesRef = useRef<Point[][]>([]);
    const currentStrokeRef = useRef<Point[] | null>(null);
    const drawingRef = useRef(false);
    // Immediate cell tracking — avoids waiting for async React state update
    const pendingCellRef = useRef<number | null>(null);
    // Morph animation tracking
    const morphTimesRef = useRef<Map<number, number>>(new Map());
    const prevBoardRef = useRef<Board>(board);
    const morphRafRef = useRef(0);
    // Dissolve animation tracking
    const dissolveStartRef = useRef<number | null>(null);
    const dissolveRafRef = useRef(0);
    // Rich biometric stroke tracking (parallel to cellStrokesRef)
    const richStrokesRef = useRef<Stroke[]>([]);
    const currentRichStrokeRef = useRef<StrokePoint[] | null>(null);
    const inputTypeRef = useRef('mouse');
    // Celebration animation
    const celebrationStartRef = useRef<number | null>(null);
    const celebrationParticlesRef = useRef<Particle[]>([]);
    const celebrationRafRef = useRef(0);

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
      getCellStrokes: () => [...cellStrokesRef.current],
      getRichStrokes: () => [...richStrokesRef.current],
      getInputType: () => inputTypeRef.current,
      clearCell: (_cellIndex: number) => {
        cellStrokesRef.current = [];
        currentStrokeRef.current = null;
        richStrokesRef.current = [];
        currentRichStrokeRef.current = null;
        dissolveStartRef.current = null;
        cancelAnimationFrame(dissolveRafRef.current);
        renderFnRef.current();
      },
      dissolveCell: () => {
        dissolveStartRef.current = performance.now();
        cancelAnimationFrame(dissolveRafRef.current);
        const loop = () => {
          const start = dissolveStartRef.current;
          if (start === null) return;
          renderFnRef.current();
          if (performance.now() - start >= DISSOLVE_MS) {
            cellStrokesRef.current = [];
            currentStrokeRef.current = null;
            richStrokesRef.current = [];
            currentRichStrokeRef.current = null;
            dissolveStartRef.current = null;
            renderFnRef.current();
          } else {
            dissolveRafRef.current = requestAnimationFrame(loop);
          }
        };
        dissolveRafRef.current = requestAnimationFrame(loop);
      },
    }));

    // Clear pending cell when React catches up
    useEffect(() => {
      pendingCellRef.current = null;
    }, [selectedCell]);

    // Clear stale strokes when selected cell resets (between moves)
    const prevSelectedRef = useRef<number | null>(null);
    useEffect(() => {
      if (prevSelectedRef.current !== null && prevSelectedRef.current !== selectedCell) {
        cellStrokesRef.current = [];
        currentStrokeRef.current = null;
        richStrokesRef.current = [];
        currentRichStrokeRef.current = null;
      }
      prevSelectedRef.current = selectedCell;
    }, [selectedCell]);

    const render = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;
      const isDrawPhase = DRAW_PHASES.includes(phase);
      const activeCell = selectedCell ?? pendingCellRef.current;

      renderGrid(ctx);
      renderPlacedMarks(ctx, board);

      if (activeCell !== null && isDrawPhase) {
        renderActiveCell(ctx, activeCell);

        // Apply dissolve fade-out if active
        const ds = dissolveStartRef.current;
        const alpha = ds !== null ? Math.max(0, 1 - (performance.now() - ds) / DISSOLVE_MS) : 1;
        renderLiveStrokes(ctx, activeCell, cellStrokesRef.current, currentStrokeRef.current, alpha);
      }

      // Win line: static for AI wins, animated celebration for human wins
      const cStart = celebrationStartRef.current;
      if (winLine && cStart !== null) {
        const progress = Math.min(1, (performance.now() - cStart) / CELEBRATION_MS);
        renderCelebration(ctx, celebrationParticlesRef.current, progress, winLine);
      } else if (winLine) {
        renderWinLine(ctx, winLine);
      }

      if (phase === 'idle') renderIdleOverlay(ctx);
    }, [board, selectedCell, winLine, phase]);

    useEffect(() => {
      render();
    }, [render]);

    // Keep a stable ref to the latest render function for animation loops
    const renderFnRef = useRef(render);
    useEffect(() => {
      // eslint-disable-next-line react-hooks/immutability -- ref is only mutated inside effects
      renderFnRef.current = render;
    });

    // Detect newly placed human cells → start morph animation
    useEffect(() => {
      const prev = prevBoardRef.current;
      // Clean up morphs for cells that were removed (e.g., reset)
      for (const [idx] of morphTimesRef.current) {
        if (!board[idx]) morphTimesRef.current.delete(idx);
      }
      let hasNew = false;
      for (let i = 0; i < 9; i++) {
        if (!prev[i] && board[i] && board[i]!.owner === 'human') {
          morphTimesRef.current.set(i, performance.now());
          hasNew = true;
        }
      }
      prevBoardRef.current = board;

      if (!hasNew && morphTimesRef.current.size === 0) return;

      const loop = () => {
        const now = performance.now();
        let anyActive = false;
        for (const [idx, t] of morphTimesRef.current) {
          if (now - t >= MORPH_MS) morphTimesRef.current.delete(idx);
          else anyActive = true;
        }
        renderFnRef.current();
        if (anyActive) {
          morphRafRef.current = requestAnimationFrame(loop);
        }
      };
      cancelAnimationFrame(morphRafRef.current);
      morphRafRef.current = requestAnimationFrame(loop);

      return () => cancelAnimationFrame(morphRafRef.current);
    }, [board]);

    // Trigger celebration particles when human wins
    useEffect(() => {
      if (!winLine || winner !== 'human') {
        celebrationStartRef.current = null;
        celebrationParticlesRef.current = [];
        cancelAnimationFrame(celebrationRafRef.current);
        return;
      }

      celebrationStartRef.current = performance.now();
      celebrationParticlesRef.current = spawnParticles(winLine);

      const loop = () => {
        const start = celebrationStartRef.current;
        if (start === null) return;
        renderFnRef.current();
        if (performance.now() - start < CELEBRATION_MS) {
          celebrationRafRef.current = requestAnimationFrame(loop);
        } else {
          celebrationStartRef.current = null;
        }
      };
      celebrationRafRef.current = requestAnimationFrame(loop);

      return () => cancelAnimationFrame(celebrationRafRef.current);
    }, [winLine, winner]);

    // ── Pointer events ───────────────────────────────────────────────
    const getCanvasPos = useCallback((e: React.PointerEvent): Point => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
      };
    }, []);

    const getCellIndex = useCallback((pos: Point) => {
      const col = Math.floor(pos.x / CELL_SIZE);
      const row = Math.floor(pos.y / CELL_SIZE);
      if (col < 0 || col > 2 || row < 0 || row > 2) return -1;
      return row * 3 + col;
    }, []);

    const onPointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.preventDefault();
        const pos = getCanvasPos(e);

        if (phase === 'idle') {
          onCellSelect(-1);
          return;
        }

        if (phase !== 'human-draw') return;

        inputTypeRef.current = e.pointerType;
        const richPoint: StrokePoint = {
          x: pos.x,
          y: pos.y,
          t: performance.now(),
          pressure: e.pressure,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          width: e.width,
          height: e.height,
          coalescedCount: 0,
          coalescedSpoofed: false,
        };

        // Cancel any active dissolve — user is drawing again
        if (dissolveStartRef.current !== null) {
          dissolveStartRef.current = null;
          cancelAnimationFrame(dissolveRafRef.current);
          cellStrokesRef.current = [];
          currentStrokeRef.current = null;
          richStrokesRef.current = [];
          currentRichStrokeRef.current = null;
        }

        const activeCell = selectedCell ?? pendingCellRef.current;

        // If we have an active cell and the tap is inside it → continue drawing
        if (activeCell !== null && isPointInCell(pos, activeCell)) {
          canvasRef.current!.setPointerCapture(e.pointerId);
          drawingRef.current = true;
          currentStrokeRef.current = [{ x: pos.x, y: pos.y }];
          currentRichStrokeRef.current = [richPoint];
          render();
          return;
        }

        // Tap is outside active cell (or no active cell) → select new empty cell + start drawing
        const cellIdx = getCellIndex(pos);
        if (cellIdx >= 0 && !board[cellIdx]) {
          // Clear old strokes when switching cells
          cellStrokesRef.current = [];
          currentStrokeRef.current = null;
          richStrokesRef.current = [];
          currentRichStrokeRef.current = null;
          pendingCellRef.current = cellIdx;
          onCellSelect(cellIdx);
          canvasRef.current!.setPointerCapture(e.pointerId);
          drawingRef.current = true;
          currentStrokeRef.current = [{ x: pos.x, y: pos.y }];
          currentRichStrokeRef.current = [richPoint];
          render();
        }
      },
      [phase, board, selectedCell, getCanvasPos, getCellIndex, onCellSelect, render]
    );

    const onPointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (!drawingRef.current || !currentStrokeRef.current) return;
        e.preventDefault();
        const pos = getCanvasPos(e);

        const activeCell = selectedCell ?? pendingCellRef.current;
        if (activeCell !== null) {
          const origin = cellOrigin(activeCell);
          pos.x = Math.max(origin.x, Math.min(origin.x + CELL_SIZE, pos.x));
          pos.y = Math.max(origin.y, Math.min(origin.y + CELL_SIZE, pos.y));
        }

        currentStrokeRef.current.push({ x: pos.x, y: pos.y });
        const coalesced = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
        currentRichStrokeRef.current?.push({
          x: pos.x,
          y: pos.y,
          t: performance.now(),
          pressure: e.pressure,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          width: e.width,
          height: e.height,
          coalescedCount: coalesced.length,
          coalescedSpoofed: isCoalescedSpoofed(coalesced),
        });
        render();
      },
      [getCanvasPos, selectedCell, render]
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent) => {
        if (!drawingRef.current) return;
        canvasRef.current?.releasePointerCapture(e.pointerId);
        drawingRef.current = false;
        if (currentStrokeRef.current && currentStrokeRef.current.length > 0) {
          cellStrokesRef.current.push(currentStrokeRef.current);
        }
        if (currentRichStrokeRef.current && currentRichStrokeRef.current.length > 0) {
          const pts = currentRichStrokeRef.current;
          richStrokesRef.current.push({
            points: pts,
            startTime: pts[0].t,
            endTime: pts[pts.length - 1].t,
          });
        }
        currentStrokeRef.current = null;
        currentRichStrokeRef.current = null;
        render();
        onStrokeEnd();
      },
      [render, onStrokeEnd]
    );

    return (
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="t3-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
    );
  }
);

TicTacToeCanvas.displayName = 'TicTacToeCanvas';
export { CELL_SIZE };
export default TicTacToeCanvas;
