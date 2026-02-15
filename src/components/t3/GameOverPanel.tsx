import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Player } from '../../game/t3-types';
import type { VerdictResult } from '../../utils/biometrics';
import { formatTime } from '../Leaderboard';
import T3Leaderboard from './T3Leaderboard';

const VERDICT_CONFIG = {
  human: { label: 'HUMAN', className: 'verdict-human' },
  bot: { label: 'BOT', className: 'verdict-bot' },
  uncertain: { label: 'UNCERTAIN', className: 'verdict-uncertain' },
} as const;

interface Props {
  winner: Player | 'draw' | null;
  elapsedMs: number;
  verdict: VerdictResult | null;
  onPlayAgain: () => void;
}

export default function GameOverPanel({ winner, elapsedMs, verdict, onPlayAgain }: Props) {
  const navigate = useNavigate();

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

      {/* Verdict badge */}
      <VerdictBadge verdict={verdict} />

      {winner === 'human' ? (
        <InitialsEntry elapsedMs={elapsedMs} onPlayAgain={onPlayAgain} navigate={navigate} />
      ) : (
        <>
          <T3Leaderboard />
          <button onClick={onPlayAgain} className="btn btn-primary btn-stack">
            Try Again
          </button>
          <button onClick={() => navigate('/')} className="btn btn-secondary btn-stack">
            Continue
          </button>
        </>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: VerdictResult | null }) {
  if (verdict) {
    const cfg = VERDICT_CONFIG[verdict.verdict];
    return (
      <div className="verdict-section">
        <div className={`verdict-badge ${cfg.className}`}>{cfg.label}</div>
        <div className="verdict-confidence">
          {Math.round(verdict.confidence * 100)}% confidence
          {verdict.neighborCount > 0 && (
            <span className="verdict-neighbors"> &middot; {verdict.neighborCount} neighbors</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="verdict-section">
      <div className="verdict-loading">
        <div className="verdict-spinner" />
        Classifying...
      </div>
    </div>
  );
}

function InitialsEntry({
  elapsedMs,
  onPlayAgain,
  navigate,
}: {
  elapsedMs: number;
  onPlayAgain: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
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
          Try Again
        </button>
        <button onClick={() => navigate('/')} className="btn btn-secondary btn-stack">
          Continue
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
