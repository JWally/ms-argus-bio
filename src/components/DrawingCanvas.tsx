import { forwardRef, useRef, useImperativeHandle, useEffect, useCallback } from 'react';
import { isCoalescedSpoofed } from '../utils/pointer-utils';

export interface StrokePoint {
  x: number;
  y: number;
  t: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  width: number;
  height: number;
  /** Number of coalesced pointer events in this dispatch. Real browsers coalesce
   *  2-6 events per frame; automation frameworks (Playwright/Puppeteer) always 0. */
  coalescedCount: number;
  /** True if coalesced events appear spoofed (identical refs/coords/timestamps) */
  coalescedSpoofed: boolean;
  /** PointerEvent.movementX — CDP dispatched events always report 0 */
  movementX: number;
  /** PointerEvent.movementY — CDP dispatched events always report 0 */
  movementY: number;
  /** Number of predicted events from getPredictedEvents(). Real browsers: 1-3, CDP: 0 */
  predictedCount: number;
  /** Delta between performance.now() and event.timeStamp. Real: 4-16ms, CDP: ~0ms */
  timestampDelta: number;
  /** Number of pointerrawupdate events since last pointermove. Real: 2-15+, CDP: 0 */
  rawUpdateCount: number;
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
  const rawUpdateCountRef = useRef(0);

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
      // willReadFrequently keeps the canvas CPU-backed so getImageData()
      // works correctly on Mac (Safari/Firefox GPU readback returns stale data).
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Count pointerrawupdate events between pointermove dispatches.
  // Real hardware fires at 125-1000Hz; CDP-dispatched events produce 0.
  // Chrome-only (feature-detected) — other browsers simply get 0.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !('onpointerrawupdate' in canvas)) return;
    const handler = () => {
      rawUpdateCountRef.current++;
    };
    canvas.addEventListener('pointerrawupdate', handler, { passive: true });
    return () => canvas.removeEventListener('pointerrawupdate', handler);
  }, []);

  function makeBasePoint(e: React.PointerEvent, pos: { x: number; y: number }) {
    const t = performance.now();
    return {
      x: pos.x,
      y: pos.y,
      t,
      pressure: e.pressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      width: e.width,
      height: e.height,
      timestampDelta: t - e.timeStamp,
    };
  }

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
        ...makeBasePoint(e, pos),
        coalescedCount: 0, // pointerdown is always a single event
        coalescedSpoofed: false,
        movementX: 0,
        movementY: 0,
        predictedCount: 0,
        rawUpdateCount: 0, // pointerdown is a single event
      };
      rawUpdateCountRef.current = 0; // reset counter for upcoming moves
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
      const coalesced = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
      const point: StrokePoint = {
        ...makeBasePoint(e, pos),
        coalescedCount: coalesced.length,
        coalescedSpoofed: isCoalescedSpoofed(coalesced),
        movementX: e.movementX,
        movementY: e.movementY,
        predictedCount: (e.nativeEvent as PointerEvent).getPredictedEvents?.()?.length ?? 0,
        rawUpdateCount: rawUpdateCountRef.current,
      };
      rawUpdateCountRef.current = 0; // reset for next pointermove
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
