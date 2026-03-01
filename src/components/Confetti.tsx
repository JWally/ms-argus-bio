import { useEffect, useState } from 'react';

const COLORS = ['#22c55e', '#6366f1', '#eab308', '#ec4899', '#06b6d4'];

interface Particle {
  id: number;
  left: number;
  color: string;
  delay: number;
  angle: number;
  distance: number;
}

function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: 10 + Math.random() * 80,
    color: COLORS[i % COLORS.length],
    delay: Math.random() * 0.6,
    angle: Math.random() * 360,
    distance: 40 + Math.random() * 80,
  }));
}

export default function Confetti({ big = false }: { big?: boolean }) {
  const [particles] = useState(() => makeParticles(big ? 60 : 25));
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => setVisible(false), big ? 3800 : 2800);
    return () => clearTimeout(id);
  }, [big]);

  if (!visible) return null;

  return (
    <div className="confetti-container" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="confetti-particle"
          style={
            {
              left: `${p.left}%`,
              backgroundColor: p.color,
              animationDelay: `${p.delay}s`,
              '--confetti-angle': `${p.angle}deg`,
              '--confetti-distance': `${p.distance}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
