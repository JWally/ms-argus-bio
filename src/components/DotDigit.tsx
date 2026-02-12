import { useRef, useEffect } from 'react';

type DigitState = 'current' | 'done' | 'upcoming';

interface DotDigitProps {
  digit: number;
  state: DigitState;
}

// Palettes per state: [digitColors, bgColors]
const PALETTES: Record<DigitState, { digit: string[]; bg: string[] }> = {
  current: {
    digit: ['#6366f1', '#818cf8', '#7c3aed', '#8b5cf6', '#a78bfa'],
    bg: ['#3b3b52', '#44445c', '#2e2e44', '#383850', '#4a4a5e'],
  },
  done: {
    digit: ['#22c55e', '#4ade80', '#16a34a', '#34d399', '#86efac'],
    bg: ['#2a3a2e', '#2e4434', '#243a28', '#334a38', '#283e2c'],
  },
  upcoming: {
    digit: ['#64748b', '#7890a8', '#5a6a80', '#6e829a', '#8298b0'],
    bg: ['#2a2a3e', '#1e1e32', '#262638', '#2e2e42', '#222234'],
  },
};

const CONFIG: Record<DigitState, { w: number; h: number; dot: number; gap: number }> = {
  current: { w: 100, h: 130, dot: 3.5, gap: 8 },
  done: { w: 64, h: 84, dot: 2.5, gap: 6 },
  upcoming: { w: 64, h: 84, dot: 2.5, gap: 6 },
};

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function DotDigit({ digit, state }: DotDigitProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { w, h, dot, gap } = CONFIG[state];
  const palette = PALETTES[state];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Build mask: render digit on offscreen canvas
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const oc = off.getContext('2d')!;
    oc.fillStyle = '#000';
    oc.fillRect(0, 0, w, h);
    oc.fillStyle = '#fff';
    oc.font = `900 ${h * 0.72}px system-ui, -apple-system, sans-serif`;
    oc.textAlign = 'center';
    oc.textBaseline = 'middle';
    oc.fillText(String(digit), w / 2, h / 2 + 2);
    const mask = oc.getImageData(0, 0, w, h).data;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Scatter dots
    const r = dot;
    for (let y = r + 1; y < h - r; y += gap) {
      for (let x = r + 1; x < w - r; x += gap) {
        const jx = x + (Math.random() - 0.5) * gap * 0.65;
        const jy = y + (Math.random() - 0.5) * gap * 0.65;

        const px = Math.max(0, Math.min(w - 1, Math.round(jx)));
        const py = Math.max(0, Math.min(h - 1, Math.round(jy)));
        const isDigit = mask[(py * w + px) * 4] > 128;

        const color = isDigit ? pick(palette.digit) : pick(palette.bg);
        const radius = r + (Math.random() - 0.5) * 1.2;

        ctx.beginPath();
        ctx.arc(jx, jy, Math.max(1, radius), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }, [digit, state, w, h, dot, gap, palette]);

  const opacity = state === 'upcoming' ? 0.4 : 1;

  return (
    <canvas ref={canvasRef} className="dot-digit-canvas" style={{ opacity }} aria-hidden="true" />
  );
}
