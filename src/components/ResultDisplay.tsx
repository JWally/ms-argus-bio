import { useMemo } from 'react';

const STORAGE_KEY = 'argus-bio-leaderboard';
const PR_KEY = 'argus-bio-pr';
const BOARD_SIZE = 10;
const MIN_TIME_MS = 2750;
const MAX_CAP_MS = 7000;

function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// North Korean IP ranges (175.45.176.0/22)
function randomNKIP(): string {
  const b3 = 176 + Math.floor(Math.random() * 4);
  const b4 = Math.floor(Math.random() * 256);
  return `175.45.${b3}.${b4}`;
}

interface StoredEntry {
  ip: string;
  timeMs: number;
}

function getOrCreateBoard(userTimeMs: number): StoredEntry[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredEntry[];
      if (Array.isArray(parsed) && parsed.length === BOARD_SIZE) return parsed;
    } catch {
      /* regenerate */
    }
  }

  // Cap at 7s for generation
  const cap = Math.min(userTimeMs, MAX_CAP_MS);
  const entries: StoredEntry[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    // Uniform distribution between MIN_TIME_MS and cap
    const t =
      MIN_TIME_MS + (cap - MIN_TIME_MS) * (i / (BOARD_SIZE - 1)) * (0.85 + Math.random() * 0.15);
    entries.push({ ip: randomNKIP(), timeMs: t });
  }
  entries.sort((a, b) => a.timeMs - b.timeMs);

  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  return entries;
}

function getPR(): number | null {
  const v = localStorage.getItem(PR_KEY);
  return v ? Number(v) : null;
}

function updatePR(timeMs: number): number {
  const current = getPR();
  if (current === null || timeMs < current) {
    localStorage.setItem(PR_KEY, String(timeMs));
    return timeMs;
  }
  return current;
}

type RowKind = 'fake' | 'current' | 'pr';

interface LeaderboardRow {
  rank: number;
  label: string;
  timeMs: number;
  kind: RowKind;
}

function buildLeaderboard(
  board: StoredEntry[],
  currentTimeMs: number | null,
  prTimeMs: number | null
): LeaderboardRow[] {
  const rows: { label: string; timeMs: number; kind: RowKind }[] = board.map((e) => ({
    label: e.ip,
    timeMs: e.timeMs,
    kind: 'fake' as RowKind,
  }));

  // Add PR if it beats anyone on the board
  if (prTimeMs !== null && prTimeMs < board[board.length - 1].timeMs) {
    // Only add PR row if it's different from the current run
    const prIsCurrent = currentTimeMs !== null && Math.abs(prTimeMs - currentTimeMs) < 1;
    if (!prIsCurrent) {
      rows.push({ label: 'PR', timeMs: prTimeMs, kind: 'pr' });
    }
  }

  // Add current run
  if (currentTimeMs !== null) {
    rows.push({ label: 'YOU', timeMs: currentTimeMs, kind: 'current' });
  }

  return rows
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, BOARD_SIZE)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

const MAX_OFF_BOARD_RANK = 50;

/**
 * Estimate rank for a time that didn't make the top 10.
 * Uses the average gap between board entries to linearly
 * extrapolate past #10. Capped at 50 (shows "50+" beyond).
 */
function estimateRank(board: StoredEntry[], userTimeMs: number): { rank: number; capped: boolean } {
  const lastTime = board[board.length - 1].timeMs;
  const overshootMs = userTimeMs - lastTime;
  if (overshootMs <= 0) return { rank: BOARD_SIZE + 1, capped: false };

  // Average gap between consecutive board entries
  const gaps: number[] = [];
  for (let i = 1; i < board.length; i++) {
    gaps.push(board[i].timeMs - board[i - 1].timeMs);
  }
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;

  // How many "slots" past #10
  const slotsBack = avgGap > 0 ? Math.ceil(overshootMs / avgGap) : 1;
  const rank = BOARD_SIZE + slotsBack;

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

  const { leaderboard, currentOnBoard, offBoardRank } = useMemo(() => {
    const b = getOrCreateBoard(totalTimeMs);
    const pr = passed ? updatePR(totalTimeMs) : getPR();
    const lb = buildLeaderboard(b, passed ? totalTimeMs : null, pr);
    const onBoard = lb.some((e) => e.kind === 'current');
    const rank = passed && !onBoard ? estimateRank(b, totalTimeMs) : null;
    return { leaderboard: lb, currentOnBoard: onBoard, offBoardRank: rank };
  }, [passed, totalTimeMs]);

  const verdictCfg = verdict ? VERDICT_CONFIG[verdict.verdict] : null;

  return (
    <div className={`result-panel ${passed ? 'result-pass' : 'result-fail'}`}>
      <div className="result-header">{passed ? 'VERIFIED' : 'TIMEOUT'}</div>
      <div className="result-time">{formatTime(totalTimeMs)}</div>

      {/* Verdict badge */}
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

      <div className="leaderboard">
        <div className="leaderboard-title">Today&apos;s Top Times</div>
        <div className="leaderboard-rows">
          {leaderboard.map((entry) => (
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
        {passed && currentOnBoard && <div className="leaderboard-msg">You made the board!</div>}
        {passed && !currentOnBoard && offBoardRank && (
          <>
            <div className="leaderboard-msg leaderboard-miss">Not fast enough this time...</div>
            <div className="leaderboard-row leaderboard-off-board">
              <span className="leaderboard-rank">
                #{offBoardRank.rank}
                {offBoardRank.capped && '+'}
              </span>
              <span className="leaderboard-label">YOU</span>
              <span className="leaderboard-time">{formatTime(totalTimeMs)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
