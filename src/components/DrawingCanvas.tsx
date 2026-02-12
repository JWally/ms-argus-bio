import { forwardRef, useRef, useImperativeHandle, useEffect, useCallback } from 'react';

export interface StrokePoint {
  x: number;
  y: number;
  t: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  width: number;
  height: number;
}

export interface Stroke {
  points: StrokePoint[];
  startTime: number;
  endTime: number;
}

export interface CanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
  getStrokes: () => Stroke[];
  getInputType: () => string;
  clear: () => void;
}

interface Props {
  disabled?: boolean;
  idle?: boolean;
}

interface RoundRectOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

function roundRect(ctx: CanvasRenderingContext2D, { x, y, w, h, r }: RoundRectOpts): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

const FONT = 'Orbitron, system-ui, sans-serif';

function drawIdleText(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const cx = canvas.width / 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ── Instruction text ──
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 17px ${FONT}`;
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('Draw the Numbers', cx, 90);
  ctx.fillText('You See Above', cx, 116);

  // ── On-theme button ──
  const btnW = 230;
  const btnH = 54;
  const btnX = cx - btnW / 2;
  const btnY = 150;
  const r = 10;

  // Glow shadow
  ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Shadow underneath
  roundRect(ctx, { x: btnX + 1, y: btnY + 3, w: btnW, h: btnH, r });
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fill();

  // Reset shadow for crisp layers
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // Bottom bevel (dark edge)
  roundRect(ctx, { x: btnX, y: btnY + 3, w: btnW, h: btnH - 1, r });
  ctx.fillStyle = '#3730a3';
  ctx.fill();

  // Main button face
  roundRect(ctx, { x: btnX, y: btnY, w: btnW, h: btnH - 4, r });
  ctx.fillStyle = '#6366f1';
  ctx.fill();

  // Top highlight
  roundRect(ctx, { x: btnX + 3, y: btnY + 2, w: btnW - 6, h: btnH / 2 - 4, r: r - 1 });
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fill();

  // Outline
  roundRect(ctx, { x: btnX, y: btnY, w: btnW, h: btnH - 1, r });
  ctx.strokeStyle = '#4338ca';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Button text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 13px ${FONT}`;
  ctx.fillStyle = '#fff';
  ctx.fillText('CLICK HERE TO START', cx, btnY + (btnH - 4) / 2);
}

const DrawingCanvas = forwardRef<CanvasHandle, Props>(({ disabled, idle }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const inputTypeRef = useRef('mouse');

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
    getStrokes: () => [...strokesRef.current],
    getInputType: () => inputTypeRef.current,
    clear: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      strokesRef.current = [];
      currentStrokeRef.current = null;
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (idle) {
      drawIdleText(canvas);
    } else {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [idle]);

  const getPos = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      canvasRef.current!.setPointerCapture(e.pointerId);
      inputTypeRef.current = e.pointerType;
      const pos = getPos(e);
      const point: StrokePoint = {
        x: pos.x,
        y: pos.y,
        t: performance.now(),
        pressure: e.pressure,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
        width: e.width,
        height: e.height,
      };
      currentStrokeRef.current = {
        points: [point],
        startTime: point.t,
        endTime: point.t,
      };
      const ctx = canvasRef.current!.getContext('2d')!;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    },
    [disabled, getPos]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!currentStrokeRef.current || disabled) return;
      e.preventDefault();
      const pos = getPos(e);
      const point: StrokePoint = {
        x: pos.x,
        y: pos.y,
        t: performance.now(),
        pressure: e.pressure,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
        width: e.width,
        height: e.height,
      };
      currentStrokeRef.current.points.push(point);
      currentStrokeRef.current.endTime = point.t;

      const ctx = canvasRef.current!.getContext('2d')!;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 18;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    },
    [disabled, getPos]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!currentStrokeRef.current) return;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    strokesRef.current.push(currentStrokeRef.current);
    currentStrokeRef.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={280}
      className="drawing-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    />
  );
});

DrawingCanvas.displayName = 'DrawingCanvas';
export default DrawingCanvas;
