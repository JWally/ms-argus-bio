import { useRef, useEffect, useMemo } from 'react';

interface DotChallengeProps {
  /** Base64-encoded 1-bit packed masks from the server (one per glyph) */
  masks: string[];
  maskWidth: number;
  maskHeight: number;
  currentIndex: number;
}

// Color palettes — bright letter dots, dim background dots
const DIGIT_PALETTES = {
  current: ['#a5b4fc', '#c4b5fd', '#93c5fd', '#c084fc', '#e0e7ff'],
  done: ['#444458', '#4a4a5e', '#3e3e52', '#505064', '#42425a'],
  upcoming: ['#444458', '#4a4a5e', '#3e3e52', '#505064', '#42425a'],
};

const BG_MUTED = ['#161624', '#131320', '#151528', '#181830', '#121220'];
const BG_SPOTLIGHT = ['#1e1e38', '#222240', '#1a1a34', '#202042', '#1c1c36'];

const DOT_R = 3;
const GAP = 6;
const H = 180;
const NUM_FRAMES = 20;
/** How many groups to show per frame (NUM_VISIBLE / NUM_FRAMES = visible ratio) */
const NUM_VISIBLE = 4;
const JITTER_PX = 1.5;

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface Dot {
  x: number;
  y: number;
  radius: number;
  realColor: string;
  bgColor: string;
  isDigit: boolean;
  frameGroup: number;
}

/** Unpack a base64-encoded 1-bit mask into a boolean lookup array */
function unpackMask(b64: string, mw: number, mh: number): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  const bits = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    bits[i] = (bytes[byteIdx] >> bitIdx) & 1;
  }
  return bits;
}

interface SampleMaskOpts {
  maskBits: Uint8Array;
  mw: number;
  mh: number;
  x: number;
  y: number;
  containerW: number;
  containerH: number;
}

/** Sample the pre-computed mask at scaled coordinates (nearest-neighbor) */
function sampleMask({ maskBits, mw, mh, x, y, containerW, containerH }: SampleMaskOpts): boolean {
  const mx = Math.min(mw - 1, Math.max(0, Math.floor((x / containerW) * mw)));
  const my = Math.min(mh - 1, Math.max(0, Math.floor((y / containerH) * mh)));
  return maskBits[my * mw + mx] === 1;
}

interface BgColorOpts {
  state: string;
  jx: number;
  jy: number;
  slotW: number;
  slot: number;
  h: number;
}

function pickBgColor({ state, jx, jy, slotW, slot, h }: BgColorOpts): string {
  if (state !== 'current') return pick(BG_MUTED);
  const slotCx = slotW * slot + slotW / 2;
  const slotCy = h / 2;
  const dist = Math.sqrt((jx - slotCx) ** 2 + (jy - slotCy) ** 2);
  const maxDist = Math.sqrt((slotW / 2) ** 2 + (h / 2) ** 2);
  return dist / maxDist < 0.7 ? pick(BG_SPOTLIGHT) : pick(BG_MUTED);
}

function pickRadius(): number {
  const sizeRoll = Math.random();
  if (sizeRoll < 0.25) return Math.max(0.8, 1 + Math.random() * 0.8);
  if (sizeRoll < 0.45) return Math.max(0.8, 1.8 + Math.random() * 0.8);
  return Math.max(0.8, DOT_R + (Math.random() - 0.5) * 1.2);
}

interface ComputeDotsOpts {
  maskBits: Uint8Array;
  mw: number;
  mh: number;
  activeSlot: number;
  w: number;
  h: number;
  slotW: number;
}

function computeDots({ maskBits, mw, mh, activeSlot, w, h, slotW }: ComputeDotsOpts): Dot[] {
  const dots: Dot[] = [];
  const numSlots = 1; // We show one glyph at a time
  for (let y = DOT_R + 1; y < h - DOT_R; y += GAP) {
    for (let x = DOT_R + 1; x < w - DOT_R; x += GAP) {
      const jx = x + (Math.random() - 0.5) * GAP * 0.55;
      const jy = y + (Math.random() - 0.5) * GAP * 0.55;

      const slot = Math.min(numSlots - 1, Math.floor(jx / slotW));
      const state = slot < activeSlot ? 'done' : slot === activeSlot ? 'current' : 'upcoming';

      const isDigit = sampleMask({ maskBits, mw, mh, x: jx, y: jy, containerW: w, containerH: h });

      const bgColor = pickBgColor({ state, jx, jy, slotW, slot, h });
      const realColor = isDigit ? pick(DIGIT_PALETTES[state]) : bgColor;

      dots.push({
        x: jx,
        y: jy,
        radius: pickRadius(),
        realColor,
        bgColor,
        isDigit,
        frameGroup: Math.floor(Math.random() * NUM_FRAMES),
      });
    }
  }
  return dots;
}

export default function DotChallenge({
  masks,
  maskWidth,
  maskHeight,
  currentIndex,
}: DotChallengeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  const currentMask = useMemo(
    () => (masks[currentIndex] ? unpackMask(masks[currentIndex], maskWidth, maskHeight) : null),
    [masks, currentIndex, maskWidth, maskHeight]
  );
  const activeSlot = 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentMask) return;

    const containerWidth = canvas.parentElement?.clientWidth ?? 280;
    const w = containerWidth;
    const h = H;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const slotW = w;
    const dots = computeDots({
      maskBits: currentMask,
      mw: maskWidth,
      mh: maskHeight,
      activeSlot,
      w,
      h,
      slotW,
    });

    // Temporal multiplexing: only 1/5 of digit dots show per frame.
    // Human eye integrates all 5 at 60fps = clear. Screenshot = 20% signal.
    let frameIndex = 0;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const batches = new Map<string, number[]>();

      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i];
        const jx = dot.x + (Math.random() - 0.5) * JITTER_PX;
        const jy = dot.y + (Math.random() - 0.5) * JITTER_PX;

        // Show NUM_VISIBLE consecutive groups each frame (same density, faster cycling)
        const groupDist = (dot.frameGroup - frameIndex + NUM_FRAMES) % NUM_FRAMES;
        const visible = groupDist < NUM_VISIBLE;
        const color = dot.isDigit && !visible ? dot.bgColor : dot.realColor;

        let batch = batches.get(color);
        if (!batch) {
          batch = [];
          batches.set(color, batch);
        }
        const r = dot.radius;
        batch.push(jx - r, jy - r, r * 2, r * 2);
      }

      for (const [color, rects] of batches) {
        ctx.fillStyle = color;
        for (let j = 0; j < rects.length; j += 4) {
          ctx.fillRect(rects[j], rects[j + 1], rects[j + 2], rects[j + 3]);
        }
      }

      frameIndex = (frameIndex + 1) % NUM_FRAMES;
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [currentMask, maskWidth, maskHeight, activeSlot]);

  return <canvas ref={canvasRef} className="dot-challenge-canvas" aria-hidden="true" />;
}
