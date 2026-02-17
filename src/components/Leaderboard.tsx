import { useMemo, useState, useEffect } from 'react';

const MOBILE_BP = 768;

export function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export type RowKind = 'fake' | 'current' | 'pr';

export interface LeaderboardRow {
  rank: number;
  label: string;
  timeMs: number;
  kind: RowKind;
}

interface StoredEntry {
  label: string;
  timeMs: number;
}

interface BoardConfig {
  storageKey: string;
  prKey: string;
  boardSize: number;
  mobileBoardSize: number;
  minTimeMs: number;
  maxCapMs: number;
  generateLabel: (index: number) => string;
}

function getOrCreateBoard(config: BoardConfig, seedTimeMs: number): StoredEntry[] {
  const stored = localStorage.getItem(config.storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredEntry[];
      if (Array.isArray(parsed) && parsed.length === config.boardSize) return parsed;
    } catch {
      /* regenerate */
    }
  }

  const cap = Math.min(seedTimeMs, config.maxCapMs);
  const entries: StoredEntry[] = [];
  for (let i = 0; i < config.boardSize; i++) {
    const t =
      config.minTimeMs +
      (cap - config.minTimeMs) * (i / (config.boardSize - 1)) * (0.85 + Math.random() * 0.15);
    entries.push({ label: config.generateLabel(i), timeMs: t });
  }
  entries.sort((a, b) => a.timeMs - b.timeMs);
  localStorage.setItem(config.storageKey, JSON.stringify(entries));
  return entries;
}

function getPR(prKey: string): number | null {
  const v = localStorage.getItem(prKey);
  return v ? Number(v) : null;
}

function updatePR(prKey: string, timeMs: number): number {
  const current = getPR(prKey);
  if (current === null || timeMs < current) {
    localStorage.setItem(prKey, String(timeMs));
    return timeMs;
  }
  return current;
}

function buildRows(
  board: StoredEntry[],
  currentTimeMs: number | null,
  currentLabel: string,
  prTimeMs: number | null,
  boardSize: number
): LeaderboardRow[] {
  const rows: { label: string; timeMs: number; kind: RowKind }[] = board.map((e) => ({
    label: e.label,
    timeMs: e.timeMs,
    kind: 'fake' as RowKind,
  }));

  if (prTimeMs !== null && prTimeMs < board[board.length - 1].timeMs) {
    const prIsCurrent = currentTimeMs !== null && Math.abs(prTimeMs - currentTimeMs) < 1;
    if (!prIsCurrent) {
      rows.push({ label: `${currentLabel} - PR*`, timeMs: prTimeMs, kind: 'pr' });
    }
  }

  if (currentTimeMs !== null) {
    rows.push({ label: currentLabel, timeMs: currentTimeMs, kind: 'current' });
  }

  return rows
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, boardSize)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

export interface LeaderboardProps {
  config: BoardConfig;
  currentTimeMs?: number | null;
  currentLabel?: string;
  title?: string;
}

export default function Leaderboard({
  config,
  currentTimeMs,
  currentLabel = 'YOU',
  title = 'Top Times',
}: LeaderboardProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BP);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const displayLimit = isMobile ? config.mobileBoardSize : config.boardSize;

  const leaderboard = useMemo(() => {
    const seedTime = currentTimeMs ?? 60_000;
    const b = getOrCreateBoard(config, seedTime);
    const pr = currentTimeMs ? updatePR(config.prKey, currentTimeMs) : getPR(config.prKey);
    return buildRows(b, currentTimeMs ?? null, currentLabel, pr, config.boardSize);
  }, [currentTimeMs, currentLabel, config]);

  return (
    <div className="leaderboard">
      <div className="leaderboard-title">{title}</div>
      <div className="leaderboard-rows">
        {leaderboard.slice(0, displayLimit).map((entry) => (
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
        const visible = leaderboard.slice(0, displayLimit);
        if (visible.some((e) => e.kind === 'current'))
          return <div className="leaderboard-msg">You made the board!</div>;
        return null;
      })()}
    </div>
  );
}

export { getOrCreateBoard, buildRows, getPR, updatePR };
export type { BoardConfig, StoredEntry };
