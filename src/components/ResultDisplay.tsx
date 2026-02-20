import { useMemo, useState, useEffect } from 'react';
import {
  formatTime,
  getOrCreateBoard,
  buildRows,
  getPR,
  updatePR,
  type BoardConfig,
  type LeaderboardRow,
} from './Leaderboard';

const MOBILE_BP = 768;
const MAX_OFF_BOARD_RANK = 50;

const ARCADE_INITIALS = [
  // Classic arcade
  'AAA',
  'ACE',
  'ARC',
  'ASH',
  'BAD',
  'BAM',
  'BEN',
  'BOB',
  'BUZ',
  'CAM',
  'CAT',
  'CPU',
  'DAD',
  'DAN',
  'DOC',
  'EVE',
  'FOX',
  'GUS',
  'HAL',
  'HEX',
  'ICE',
  'JAM',
  'JAX',
  'JET',
  'JOE',
  'KAI',
  'KAT',
  'LEX',
  'MAX',
  'MEL',
  'MOM',
  'NEO',
  'NPC',
  'PAT',
  'PEW',
  'RAD',
  'RAM',
  'REX',
  'RYU',
  'SAM',
  'SKY',
  'TAZ',
  'TOM',
  'VEX',
  'WAX',
  'XAN',
  'YAK',
  'ZAP',
  'ZED',
  'ZOE',
  // Famous initials
  'JFK',
  'RFK',
  'MLK',
  'FDR',
  'LBJ',
  'RBG',
  'MJK',
  'MJF',
  'DMX',
  'JRR',
  'GRR',
  'ODB',
  'MCA',
  'RZA',
  'GZA',
  'JLO',
  'BJK',
  'EMF',
  'TLC',
  'DMC',
];

const BIO_CONFIG: BoardConfig = {
  storageKey: 'argus-bio-leaderboard-v2',
  prKey: 'argus-bio-pr',
  boardSize: 10,
  mobileBoardSize: 5,
  minTimeMs: 2750,
  maxCapMs: 7000,
  generateLabel: () => ARCADE_INITIALS[Math.floor(Math.random() * ARCADE_INITIALS.length)],
};

function estimateRank(
  boardSize: number,
  lastTime: number,
  userTimeMs: number,
  avgGap: number
): { rank: number; capped: boolean } {
  const overshootMs = userTimeMs - lastTime;
  if (overshootMs <= 0) return { rank: boardSize + 1, capped: false };
  const slotsBack = avgGap > 0 ? Math.ceil(overshootMs / avgGap) : 1;
  const rank = boardSize + slotsBack;
  if (rank > MAX_OFF_BOARD_RANK) return { rank: MAX_OFF_BOARD_RANK, capped: true };
  return { rank, capped: false };
}

interface VerdictResult {
  verdict: 'human' | 'bot' | 'uncertain';
  confidence: number;
  neighborCount: number;
  heuristicLabel: string;
}

interface ResultDisplayProps {
  totalTimeMs: number;
  timedOut: boolean;
  verdict: VerdictResult | null;
}

const VERDICT_CONFIG = {
  human: { label: 'HUMAN', className: 'verdict-human' },
  bot: { label: 'BOT', className: 'verdict-bot' },
  uncertain: { label: 'UNCERTAIN', className: 'verdict-uncertain' },
} as const;

export default function ResultDisplay({ totalTimeMs, timedOut, verdict }: ResultDisplayProps) {
  const passed = !timedOut;
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BP);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const displayLimit = isMobile ? BIO_CONFIG.mobileBoardSize : BIO_CONFIG.boardSize;

  const { leaderboard, offBoardRank } = useMemo(() => {
    const b = getOrCreateBoard(BIO_CONFIG, totalTimeMs);
    const pr = passed ? updatePR(BIO_CONFIG.prKey, totalTimeMs) : getPR(BIO_CONFIG.prKey);
    const lb = buildRows(b, passed ? totalTimeMs : null, 'YOU', pr, BIO_CONFIG.boardSize);
    const onBoard = lb.some((e) => e.kind === 'current');

    let rank: { rank: number; capped: boolean } | null = null;
    if (passed && !onBoard) {
      const last = b[b.length - 1].timeMs;
      const gaps = b.slice(1).map((e, i) => e.timeMs - b[i].timeMs);
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      rank = estimateRank(BIO_CONFIG.boardSize, last, totalTimeMs, avgGap);
    }
    return { leaderboard: lb, offBoardRank: rank };
  }, [passed, totalTimeMs]);

  const verdictCfg = verdict ? VERDICT_CONFIG[verdict.verdict] : null;

  return (
    <div className={`result-panel ${passed ? 'result-pass' : 'result-fail'}`}>
      <div className="result-header">{passed ? 'VERIFIED' : 'TIMEOUT'}</div>
      <div className="result-time">{formatTime(totalTimeMs)}</div>

      {/* Verdict badge */}
      {!timedOut && (
        <div className="verdict-section">
          {verdict ? (
            <>
              <div className={`verdict-badge ${verdictCfg!.className}`}>{verdictCfg!.label}</div>
              <div className="verdict-confidence">
                {Math.round(verdict.confidence * 100)}% confidence
                {verdict.neighborCount > 0 && (
                  <span className="verdict-neighbors">
                    {' '}
                    &middot; {verdict.neighborCount} neighbors
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="verdict-loading">
              <div className="verdict-spinner" />
              Classifying...
            </div>
          )}
        </div>
      )}

      <LeaderboardTable
        rows={leaderboard}
        displayLimit={displayLimit}
        passed={passed}
        totalTimeMs={totalTimeMs}
        offBoardRank={offBoardRank}
      />
    </div>
  );
}

function LeaderboardTable({
  rows,
  displayLimit,
  passed,
  totalTimeMs,
  offBoardRank,
}: {
  rows: LeaderboardRow[];
  displayLimit: number;
  passed: boolean;
  totalTimeMs: number;
  offBoardRank: { rank: number; capped: boolean } | null;
}) {
  return (
    <div className="leaderboard">
      <div className="leaderboard-title">Today&apos;s Top Times</div>
      <div className="leaderboard-rows">
        {rows.slice(0, displayLimit).map((entry) => (
          <div
            key={`${entry.kind}-${entry.rank}`}
            className={[
              'leaderboard-row',
              entry.kind === 'current' && 'leaderboard-current',
              entry.kind === 'pr' && 'leaderboard-pr',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="leaderboard-rank">#{entry.rank}</span>
            <span className="leaderboard-label">{entry.label}</span>
            <span className="leaderboard-time">{formatTime(entry.timeMs)}</span>
          </div>
        ))}
      </div>
      {(() => {
        const visibleRows = rows.slice(0, displayLimit);
        const youVisible = visibleRows.some((e) => e.kind === 'current');
        if (!passed) return null;
        if (youVisible) return <div className="leaderboard-msg">You made the board!</div>;
        const fullRank = rows.findIndex((e) => e.kind === 'current');
        const rank = fullRank >= 0 ? fullRank + 1 : offBoardRank?.rank;
        const capped = fullRank < 0 && offBoardRank?.capped;
        if (!rank) return null;
        return (
          <>
            <div className="leaderboard-msg leaderboard-miss">Not fast enough this time...</div>
            <div className="leaderboard-row leaderboard-off-board">
              <span className="leaderboard-rank">
                #{rank}
                {capped && '+'}
              </span>
              <span className="leaderboard-label">YOU</span>
              <span className="leaderboard-time">{formatTime(totalTimeMs)}</span>
            </div>
          </>
        );
      })()}
    </div>
  );
}
