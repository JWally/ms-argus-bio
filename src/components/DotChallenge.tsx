import { useRef, useEffect } from 'react';

interface DotChallengeProps {
  digits: number[];
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
const H = 120;

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function DotChallenge({ digits, currentIndex }: DotChallengeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // eslint-disable-next-line sonarjs/cognitive-complexity
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
    ctx.scale(dpr, dpr);

    const slotW = w / digits.length;

    // Build mask for all digits on an offscreen canvas
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
    for (let i = 0; i < digits.length; i++) {
      oc.fillText(String(digits[i]), slotW * i + slotW / 2, h / 2 + 2);
    }
    const mask = oc.getImageData(0, 0, w, h).data;

    ctx.clearRect(0, 0, w, h);

    // Scatter dots across entire canvas
    for (let y = DOT_R + 1; y < h - DOT_R; y += GAP) {
      for (let x = DOT_R + 1; x < w - DOT_R; x += GAP) {
        const jx = x + (Math.random() - 0.5) * GAP * 0.55;
        const jy = y + (Math.random() - 0.5) * GAP * 0.55;

        const slot = Math.min(digits.length - 1, Math.floor(jx / slotW));
        const state = slot < currentIndex ? 'done' : slot === currentIndex ? 'current' : 'upcoming';

        const px = Math.max(0, Math.min(w - 1, Math.round(jx)));
        const py = Math.max(0, Math.min(h - 1, Math.round(jy)));
        const isDigit = mask[(py * w + px) * 4] > 128;

        let color: string;
        if (isDigit) {
          color = pick(DIGIT_PALETTES[state]);
        } else if (state === 'current') {
          const slotCx = slotW * slot + slotW / 2;
          const slotCy = h / 2;
          const dist = Math.sqrt((jx - slotCx) ** 2 + (jy - slotCy) ** 2);
          const maxDist = Math.sqrt((slotW / 2) ** 2 + (h / 2) ** 2);
          color = dist / maxDist < 0.7 ? pick(BG_SPOTLIGHT) : pick(BG_MUTED);
        } else {
          color = pick(BG_MUTED);
        }

        // Vary dot sizes: mix of normal and smaller dots
        const sizeRoll = Math.random();
        let radius: number;
        if (sizeRoll < 0.25) {
          radius = 1 + Math.random() * 0.8; // small dots
        } else if (sizeRoll < 0.45) {
          radius = 1.8 + Math.random() * 0.8; // medium-small
        } else {
          radius = DOT_R + (Math.random() - 0.5) * 1.2; // normal
        }

        ctx.beginPath();
        ctx.arc(jx, jy, Math.max(0.8, radius), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }, [digits, currentIndex]);

  return <canvas ref={canvasRef} className="dot-challenge-canvas" aria-hidden="true" />;
}
