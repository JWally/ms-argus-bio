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
}

const DrawingCanvas = forwardRef<CanvasHandle, Props>(({ disabled }, ref) => {
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

  // Sync canvas buffer to CSS size so aspect ratio is never distorted
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const sync = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

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
      if (disabled || !e.isTrusted) return;
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
      if (!currentStrokeRef.current || disabled || !e.isTrusted) return;
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
