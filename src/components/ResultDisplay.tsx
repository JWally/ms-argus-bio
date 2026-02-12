import { useMemo, useState } from 'react';

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

interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
}

interface BiometricFeatures {
  strokeCount: number;
  totalPoints: number;
  avgSpeed: number;
  speedVariance: number;
  maxSpeed: number;
  avgPressure: number;
  pressureVariance: number;
  avgContactWidth: number;
  avgContactHeight: number;
  totalDurationMs: number;
  avgTimeBetweenStrokes: number;
  eventFrequencyHz: number;
  avgJerk: number;
}

interface ResultDisplayProps {
  totalTimeMs: number;
  timedOut: boolean;
  verdict: VerdictResult | null;
  digits: DigitResult[];
  features: BiometricFeatures;
}

const VERDICT_CONFIG = {
  human: { label: 'HUMAN', className: 'verdict-human' },
  bot: { label: 'BOT', className: 'verdict-bot' },
  uncertain: { label: 'UNCERTAIN', className: 'verdict-uncertain' },
} as const;

export default function ResultDisplay({
  totalTimeMs,
  timedOut,
  verdict,
  digits,
  features,
}: ResultDisplayProps) {
  const passed = !timedOut;
  const [statsOpen, setStatsOpen] = useState(false);

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

      {/* Stats drawer toggle */}
      <button
        className="btn-stats-toggle"
        onClick={() => setStatsOpen((o) => !o)}
        aria-expanded={statsOpen}
      >
        {statsOpen ? 'Hide Stats' : 'Show Stats'}
        <span className={`stats-chevron ${statsOpen ? 'stats-chevron-open' : ''}`}>&#9662;</span>
      </button>

      {/* Stats drawer */}
      <div className={`stats-drawer ${statsOpen ? 'stats-drawer-open' : ''}`}>
        <div className="stats-content">
          {/* Per-digit breakdown */}
          <div className="stats-section">
            <div className="stats-section-title">Per-Digit Breakdown</div>
            <div className="stats-grid">
              {digits.map((d, i) => (
                <div key={i} className="stats-digit-card">
                  <div className="stats-digit-target">{d.target}</div>
                  <div className="stats-digit-row">
                    <span className="stats-label">Recognized</span>
                    <span className="stats-value">{d.recognized}</span>
                  </div>
                  <div className="stats-digit-row">
                    <span className="stats-label">Confidence</span>
                    <span className="stats-value">{(d.confidence * 100).toFixed(1)}%</span>
                  </div>
                  <div className="stats-digit-row">
                    <span className="stats-label">Time</span>
                    <span className="stats-value">{formatTime(d.timeMs)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Biometric features */}
          <div className="stats-section">
            <div className="stats-section-title">Biometric Features</div>
            <div className="stats-table">
              <StatRow label="Strokes" value={features.strokeCount} />
              <StatRow label="Total Points" value={features.totalPoints} />
              <StatRow label="Avg Speed" value={features.avgSpeed.toFixed(3)} unit="px/ms" />
              <StatRow label="Max Speed" value={features.maxSpeed.toFixed(3)} unit="px/ms" />
              <StatRow label="Speed Variance" value={features.speedVariance.toFixed(4)} />
              <StatRow label="Avg Pressure" value={features.avgPressure.toFixed(3)} />
              <StatRow
                label="Event Frequency"
                value={features.eventFrequencyHz.toFixed(1)}
                unit="Hz"
              />
              <StatRow label="Avg Jerk" value={features.avgJerk.toFixed(5)} />
              <StatRow label="Total Duration" value={formatTime(features.totalDurationMs)} />
              <StatRow
                label="Avg Stroke Gap"
                value={features.avgTimeBetweenStrokes.toFixed(0)}
                unit="ms"
              />
            </div>
          </div>

          {/* Classification details */}
          {verdict && (
            <div className="stats-section">
              <div className="stats-section-title">Classification</div>
              <div className="stats-table">
                <StatRow label="Verdict" value={verdict.verdict.toUpperCase()} />
                <StatRow label="Confidence" value={`${Math.round(verdict.confidence * 100)}%`} />
                <StatRow label="Neighbors" value={verdict.neighborCount} />
                <StatRow label="Heuristic" value={verdict.heuristicLabel} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="stats-row">
      <span className="stats-label">{label}</span>
      <span className="stats-value">
        {value}
        {unit && <span className="stats-unit"> {unit}</span>}
      </span>
    </div>
  );
}
