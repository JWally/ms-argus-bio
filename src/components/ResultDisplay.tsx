import { useState, useEffect } from 'react';
import {
  TIER_LABELS,
  TIER_FAKE_COUNTS,
  getNextTier,
  type Tier,
  type BoardEntry,
} from '../utils/progression';
import Confetti from './Confetti';
import { formatTime } from './Leaderboard';

interface VerdictResult {
  verdict: 'human' | 'bot' | 'uncertain';
  score?: number;
}

interface ResultDisplayProps {
  totalTimeMs: number;
  timedOut: boolean;
  verdict: VerdictResult | null;
  tier: Tier;
  boardEntries: BoardEntry[];
  boardMode: 'normal' | 'cleared' | 'shake' | 'off-pace';
  isNewPR: boolean;
  tierCleared: boolean;
}

const VERDICT_CONFIG = {
  human: { label: 'HUMAN', className: 'verdict-human' },
  bot: { label: 'BOT', className: 'verdict-bot' },
  uncertain: { label: 'UNCERTAIN', className: 'verdict-uncertain' },
} as const;

const TIER_ACCENT: Record<Tier, string> = {
  city: 'tier-city',
  region: 'tier-region',
  state: 'tier-state',
  country: 'tier-country',
};

const MOBILE_BREAKPOINT = 768;

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

export default function ResultDisplay({
  totalTimeMs,
  timedOut,
  verdict,
  tier,
  boardEntries,
  boardMode,
  isNewPR,
  tierCleared,
}: ResultDisplayProps) {
  const passed = !timedOut;
  const verdictCfg = verdict ? VERDICT_CONFIG[verdict.verdict] : null;
  const isMobile = useIsMobile();

  const playerEntry = boardEntries.find((e) => e.isPlayer);
  const playerRank = playerEntry?.rank ?? boardEntries.length + 1;

  const nextTier = getNextTier(tier);
  const nextLabel = nextTier ? TIER_LABELS[nextTier] : null;

  const totalPlayers = TIER_FAKE_COUNTS[tier];
  const rawEstimate = Math.round(totalPlayers * (playerRank / boardEntries.length));
  const estimatedRank = rawEstimate <= 99 ? `#${rawEstimate}` : '';

  // Board display size: 10 on desktop, 5 on mobile
  const boardSize = isMobile ? 5 : 10;
  // On mobile, if player is ranked beyond boardSize, show truncated view
  const playerOffVisible = playerRank > boardSize;

  return (
    <div className={`result-panel ${passed ? 'result-pass' : 'result-fail'} ${TIER_ACCENT[tier]}`}>
      {tierCleared && <Confetti big />}

      {/* Tier-cleared celebration overlay */}
      {tierCleared && nextLabel ? (
        <div className="tier-cleared">
          <div className="tier-cleared-header">LEVEL CLEARED</div>
          <div className="tier-cleared-time">{formatTime(totalTimeMs)}</div>
          <div className="tier-cleared-promotion">
            Advancing to <span className="tier-cleared-next">{nextLabel}</span>
          </div>
          <div className="tier-cleared-dots">
            <span className="tier-cleared-dot" />
            <span className="tier-cleared-dot" />
            <span className="tier-cleared-dot" />
          </div>
        </div>
      ) : (
        <>
          <div className="result-header">{passed ? 'VERIFIED' : 'TIMEOUT'}</div>
          <div className="result-time">{formatTime(totalTimeMs)}</div>

          {/* Verdict badge */}
          {!timedOut && (
            <div className="verdict-section">
              {verdict ? (
                <>
                  <div className={`verdict-badge ${verdictCfg!.className}`}>
                    {verdictCfg!.label}
                  </div>
                  {verdict.score != null && (
                    <div className="verdict-confidence">Letter Quality: {verdict.score}%</div>
                  )}
                </>
              ) : (
                <div className="verdict-loading">
                  <div className="verdict-spinner" />
                  Classifying...
                </div>
              )}
            </div>
          )}

          {/* Tier board */}
          {passed && (
            <div className="tier-board">
              <div className={`tier-label ${TIER_ACCENT[tier]}`}>
                {TIER_LABELS[tier].toUpperCase()}&apos;S TOP TIMES
              </div>

              {boardMode === 'off-pace' || playerOffVisible ? (
                /* Off-pace or player below visible board: top entries, ..., player */
                <>
                  <div className="tier-entries">
                    {boardEntries
                      .filter((e) => !e.isPlayer)
                      .slice(0, boardSize)
                      .map((entry, i) => (
                        <div
                          key={`${entry.label}-${entry.rank}`}
                          className="tier-entry"
                          style={{ animationDelay: `${i * 80}ms` }}
                        >
                          <span className="tier-entry-rank">#{entry.rank}</span>
                          <span className="tier-entry-label">{entry.label}</span>
                          <span className="tier-entry-time">{formatTime(entry.timeMs)}</span>
                        </div>
                      ))}
                  </div>
                  <div className="tier-ellipsis">&middot;&middot;&middot;</div>
                  <div className="tier-entries">
                    <div
                      className="tier-entry tier-entry-off-pace"
                      style={{ animationDelay: `${(boardSize + 1) * 80}ms` }}
                    >
                      <span className="tier-entry-rank">{estimatedRank}</span>
                      <span className="tier-entry-label">YOU</span>
                      <span className="tier-entry-time">{formatTime(totalTimeMs)}</span>
                    </div>
                  </div>
                  <div className="tier-total">Out of {totalPlayers.toLocaleString()} players</div>
                </>
              ) : (
                /* Normal / shake: show board up to boardSize */
                <>
                  <div
                    className={`tier-entries ${boardMode === 'shake' ? 'tier-entries-shake' : ''}`}
                  >
                    {boardEntries.slice(0, boardSize).map((entry, i) => (
                      <div
                        key={`${entry.label}-${entry.rank}`}
                        className={`tier-entry ${entry.isPlayer ? 'tier-entry-player' : ''}`}
                        style={{ animationDelay: `${i * 80}ms` }}
                      >
                        <span className="tier-entry-rank">#{entry.rank}</span>
                        <span className="tier-entry-label">
                          {entry.label}
                          {entry.isPlayer && isNewPR && <span className="pr-badge">PR</span>}
                        </span>
                        <span className="tier-entry-time">{formatTime(entry.timeMs)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="tier-msg tier-msg-success">
                    {isNewPR ? 'New personal best!' : 'You made the board!'}
                  </div>

                  <div className="tier-total">Out of {totalPlayers.toLocaleString()} players</div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
