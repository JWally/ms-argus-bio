import { useState } from 'react';
import type { Player } from '../../game/t3-types';
import { formatTime } from '../Leaderboard';
import T3Leaderboard from './T3Leaderboard';

interface Props {
  winner: Player | 'draw' | null;
  elapsedMs: number;
  onPlayAgain: () => void;
}

export default function GameOverPanel({ winner, elapsedMs, onPlayAgain }: Props) {
  if (!winner) return null;

  const label = winner === 'human' ? 'YOU WIN' : winner === 'ai' ? 'AI WINS' : 'DRAW';
  const className =
    winner === 'human'
      ? 't3-result t3-result-win'
      : winner === 'ai'
        ? 't3-result t3-result-lose'
        : 't3-result t3-result-draw';

  return (
    <div className={className}>
      <div className="t3-result-header">{label}</div>
      <div className="t3-result-time">{formatTime(elapsedMs)}</div>
      {winner === 'human' ? (
        <InitialsEntry elapsedMs={elapsedMs} onPlayAgain={onPlayAgain} />
      ) : (
        <>
          <T3Leaderboard />
          <button onClick={onPlayAgain} className="btn btn-primary btn-stack">
            Play Again
          </button>
        </>
      )}
    </div>
  );
}

function InitialsEntry({ elapsedMs, onPlayAgain }: { elapsedMs: number; onPlayAgain: () => void }) {
  const [initials, setInitials] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    if (initials.length === 0) return;
    setSaved(true);
  };

  if (saved) {
    return (
      <>
        <T3Leaderboard totalTimeMs={elapsedMs} initials={initials.padEnd(3, ' ').slice(0, 3)} />
        <button onClick={onPlayAgain} className="btn btn-primary btn-stack">
          Play Again
        </button>
      </>
    );
  }

  return (
    <div className="t3-initials-entry">
      <label className="t3-initials-label">Enter your initials</label>
      <div className="t3-initials-row">
        <input
          type="text"
          className="t3-initials-input"
          maxLength={3}
          value={initials}
          onChange={(e) => setInitials(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          placeholder="AAA"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
        <button onClick={handleSave} className="btn btn-primary" disabled={initials.length === 0}>
          Save
        </button>
      </div>
    </div>
  );
}
