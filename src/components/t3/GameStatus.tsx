import { useMemo } from 'react';
import DotChallenge from '../DotChallenge';
import { noisifyImage } from '../../utils/mask';
import type { Board, GamePhase } from '../../game/t3-types';

interface Props {
  phase: GamePhase;
  /** Base64-encoded 8-bit grayscale image from the server (or client fallback) */
  image: string;
  imageWidth: number;
  imageHeight: number;
  message: string;
  board: Board;
  selectedCell: number | null;
}

export default function GameStatus({
  phase,
  image,
  imageWidth,
  imageHeight,
  message,
  board,
  selectedCell,
}: Props) {
  const isPlaying = phase === 'human-draw' || phase === 'human-recognize' || phase === 'ai-turn';
  const boardEmpty = board.every((c) => c === null);
  const dimmed = phase === 'ai-turn';

  const noisyImage = useMemo(
    () => (isPlaying && image ? noisifyImage(image) : ''),
    [image, isPlaying]
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
            images={[noisyImage]}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            currentIndex={0}
            frameStep={4}
          />
        </div>
      )}

      {isPlaying && boardEmpty && !dimmed && selectedCell === null && (
        <div className="t3-status-nudge">Tap a cell, draw the letter, then hit NEXT</div>
      )}

      {message && <div className="t3-status-message">{message}</div>}
    </div>
  );
}
