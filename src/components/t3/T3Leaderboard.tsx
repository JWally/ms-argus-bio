import Leaderboard, { type BoardConfig } from '../Leaderboard';

const FAKE_INITIALS = ['ACE', 'MAX', 'ZAP', 'NEO', 'RYU', 'JET', 'KAI', 'VEX', 'AXE', 'ZEN'];

const T3_CONFIG: BoardConfig = {
  storageKey: 'argus-t3-leaderboard',
  prKey: 'argus-t3-pr',
  boardSize: 10,
  mobileBoardSize: 5,
  minTimeMs: 15_000,
  maxCapMs: 120_000,
  generateLabel: (i) => FAKE_INITIALS[i],
};

interface T3LeaderboardProps {
  totalTimeMs?: number | null;
  initials?: string | null;
}

export default function T3Leaderboard({ totalTimeMs, initials }: T3LeaderboardProps) {
  return (
    <Leaderboard
      config={T3_CONFIG}
      currentTimeMs={totalTimeMs}
      currentLabel={initials ?? 'YOU'}
      title="Top Times"
    />
  );
}
