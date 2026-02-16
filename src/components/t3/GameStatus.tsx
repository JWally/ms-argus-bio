import type { Board, GamePhase } from '../../game/t3-types';

interface Props {
  phase: GamePhase;
  targetLetter: string;
  message: string;
  board: Board;
}

export default function GameStatus({ phase, targetLetter, message, board }: Props) {
  const showLetter = phase === 'human-draw' || phase === 'human-recognize';
  const boardEmpty = board.every((c) => c === null);

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

      {showLetter && boardEmpty && (
        <div className="t3-status-nudge">Tap a cell, draw the letter, then hit DONE</div>
      )}

      {phase === 'ai-turn' && (
        <div className="t3-status-text t3-status-thinking">AI thinking...</div>
      )}

      {message && <div className="t3-status-message">{message}</div>}
    </div>
  );
}
