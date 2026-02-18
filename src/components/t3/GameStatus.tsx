import { useMemo } from 'react';
import DotChallenge from '../DotChallenge';
import { noisifyMask } from '../../utils/mask';
import type { Board, GamePhase } from '../../game/t3-types';

interface Props {
  phase: GamePhase;
  /** Base64-encoded 1-bit packed mask from the server (or client fallback) */
  mask: string;
  maskWidth: number;
  maskHeight: number;
  message: string;
  board: Board;
}

export default function GameStatus({ phase, mask, maskWidth, maskHeight, message, board }: Props) {
  const isPlaying = phase === 'human-draw' || phase === 'human-recognize' || phase === 'ai-turn';
  const boardEmpty = board.every((c) => c === null);
  const dimmed = phase === 'ai-turn';

  const noisyMask = useMemo(
    () => (isPlaying && mask ? noisifyMask(mask, maskWidth, maskHeight) : ''),
    [mask, maskWidth, maskHeight, isPlaying]
  );

  return (
    <div className="t3-status">
      {phase === 'loading' && (
        <div className="t3-status-loading">
          <div className="spinner" />
          <span className="t3-status-text">Loading model...</span>
        </div>
      )}

      {isPlaying && (
        <div className={`t3-status-letter${dimmed ? ' t3-status-dimmed' : ''}`}>
          <DotChallenge
            masks={[noisyMask]}
            maskWidth={maskWidth}
            maskHeight={maskHeight}
            currentIndex={0}
          />
        </div>
      )}

      {isPlaying && boardEmpty && !dimmed && (
        <div className="t3-status-nudge">Tap a cell, draw the letter, then hit NEXT</div>
      )}

      {message && <div className="t3-status-message">{message}</div>}
    </div>
  );
}
