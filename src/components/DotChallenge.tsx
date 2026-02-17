import { useRef, useEffect, useState, useMemo } from 'react';

interface DotChallengeProps {
  glyphs: string[];
  currentIndex: number;
}

// Color palettes
const DIGIT_PALETTES = {
  current: ['#6366f1', '#818cf8', '#7c3aed', '#8b5cf6', '#a78bfa'],
  done: ['#555568', '#5a5a6e', '#4e4e62', '#606074', '#52526a'],
  upcoming: ['#555568', '#5a5a6e', '#4e4e62', '#606074', '#52526a'],
};

const BG_MUTED = ['#26263a', '#1e1e32', '#222236', '#2a2a3e', '#202034'];
const BG_SPOTLIGHT = ['#32325a', '#383868', '#2e2e54', '#363660', '#3a3a62'];

const DOT_R = 3;
const GAP = 6;
const H = 180;
const MOBILE_BP = 768;
const NUM_FRAMES = 3;
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

function buildMask(glyphs: string[], w: number, h: number, slotW: number): Uint8ClampedArray {
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const oc = off.getContext('2d', { willReadFrequently: true })!;
  oc.fillStyle = '#000';
  oc.fillRect(0, 0, w, h);
  oc.fillStyle = '#fff';
  oc.font = `900 ${h * 0.72}px system-ui, -apple-system, sans-serif`;
  oc.textAlign = 'center';
  oc.textBaseline = 'middle';
  for (let i = 0; i < glyphs.length; i++) {
    oc.fillText(glyphs[i], slotW * i + slotW / 2, h / 2 + 2);
  }
  return oc.getImageData(0, 0, w, h).data;
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
  glyphs: string[];
  activeSlot: number;
  mask: Uint8ClampedArray;
  w: number;
  h: number;
  slotW: number;
}

function computeDots({ glyphs, activeSlot, mask, w, h, slotW }: ComputeDotsOpts): Dot[] {
  const dots: Dot[] = [];
  for (let y = DOT_R + 1; y < h - DOT_R; y += GAP) {
    for (let x = DOT_R + 1; x < w - DOT_R; x += GAP) {
      const jx = x + (Math.random() - 0.5) * GAP * 0.55;
      const jy = y + (Math.random() - 0.5) * GAP * 0.55;

      const slot = Math.min(glyphs.length - 1, Math.floor(jx / slotW));
      const state = slot < activeSlot ? 'done' : slot === activeSlot ? 'current' : 'upcoming';

      const px = Math.max(0, Math.min(w - 1, Math.round(jx)));
      const py = Math.max(0, Math.min(h - 1, Math.round(jy)));
      const isDigit = mask[(py * w + px) * 4] > 128;

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

export default function DotChallenge({ glyphs, currentIndex }: DotChallengeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BP);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const visibleGlyphs = useMemo(
    () => (isMobile ? [glyphs[currentIndex]] : glyphs),
    [isMobile, glyphs, currentIndex]
  );
  const activeSlot = isMobile ? 0 : currentIndex;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

    const slotW = w / visibleGlyphs.length;
    const mask = buildMask(visibleGlyphs, w, h, slotW);
    const dots = computeDots({ glyphs: visibleGlyphs, activeSlot, mask, w, h, slotW });

    // Animation loop — cycles frame groups so only 1/3 of digit dots
    // show their real color per frame. Screenshots capture a single frame
    // = unreadable. Human eye integrates all 3 at 60fps = clear.
    let frameIndex = 0;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Batch by color to minimize fillStyle switches
      const batches = new Map<string, number[]>();

      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i];
        const jx = dot.x + (Math.random() - 0.5) * JITTER_PX;
        const jy = dot.y + (Math.random() - 0.5) * JITTER_PX;

        // Digit dots only visible on their assigned frame
        const color = dot.isDigit && dot.frameGroup !== frameIndex ? dot.bgColor : dot.realColor;

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
        for (let i = 0; i < rects.length; i += 4) {
          ctx.fillRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
        }
      }

      frameIndex = (frameIndex + 1) % NUM_FRAMES;
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [visibleGlyphs, activeSlot]);

  return <canvas ref={canvasRef} className="dot-challenge-canvas" aria-hidden="true" />;
}
