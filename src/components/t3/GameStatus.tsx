import type { GamePhase } from '../../game/t3-types';

interface Props {
  phase: GamePhase;
  targetLetter: string;
  message: string;
}

export default function GameStatus({ phase, targetLetter, message }: Props) {
  const showLetter = phase === 'human-draw' || phase === 'human-recognize';

  return (
    <div className="t3-status">
      {phase === 'loading' && (
        <div className="t3-status-loading">
          <div className="spinner" />
          <span className="t3-status-text">Loading model...</span>
        </div>
      )}

      {showLetter && (
        <div className="t3-status-letter">
          <span className="t3-status-label">Draw</span>
          <span className="t3-target-letter">{targetLetter}</span>
        </div>
      )}

      {phase === 'ai-turn' && (
        <div className="t3-status-text t3-status-thinking">AI thinking...</div>
      )}

      {message && <div className="t3-status-message">{message}</div>}
    </div>
  );
}
