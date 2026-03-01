const STORAGE_KEY = 'argus-bio-progress';

export const TIERS = ['city', 'region', 'state', 'country'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  city: 'Your City',
  region: 'Your Region',
  state: 'Your State',
  country: 'Your Country',
};

export const TIER_FAKE_COUNTS: Record<Tier, number> = {
  city: 847,
  region: 4_200,
  state: 31_000,
  country: 285_000,
};

/** How many of the 9 fake entries should be faster than the user per tier */
const TIER_FASTER: Record<Tier, [number, number]> = {
  city: [2, 4],
  region: [3, 5],
  state: [4, 7],
  country: [6, 9],
};

/** Multiplier range for entries faster than the user (tighter = more beatable) */
const TIER_FAST_RANGE: Record<Tier, [number, number]> = {
  city: [0.92, 0.99],
  region: [0.82, 0.97],
  state: [0.7, 0.95],
  country: [0.55, 0.92],
};

/** Multiplier range for entries slower than the user */
const TIER_SLOW_RANGE: Record<Tier, [number, number]> = {
  city: [1.02, 1.4],
  region: [1.03, 1.5],
  state: [1.05, 1.6],
  country: [1.05, 1.8],
};

export interface BoardEntry {
  rank: number;
  label: string;
  timeMs: number;
  isPlayer: boolean;
}

export interface Progress {
  playerId: string;
  currentTier: Tier;
  bestByTier: Partial<Record<Tier, number>>;
  /** First completion time per tier — fakes are anchored to this so the board is stable */
  baselineByTier: Partial<Record<Tier, number>>;
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────

function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Fake name generation ──────────────────────────────────────────

const ARCADE_INITIALS = [
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
];

// ── Board generation ──────────────────────────────────────────────

/**
 * Generate a fake leaderboard.
 * @param playerTimeMs  The player's actual completion time this attempt.
 * @param tier          Current tier.
 * @param playerId      Stable player id (for seeded PRNG).
 * @param referenceTimeMs  Anchor time for generating fakes (baseline).
 *                         If omitted, uses playerTimeMs (first attempt).
 */
export function generateBoard(
  playerTimeMs: number,
  tier: Tier,
  playerId: string,
  referenceTimeMs?: number
): BoardEntry[] {
  const refTime = referenceTimeMs ?? playerTimeMs;
  const today = new Date().toISOString().slice(0, 10);
  const seed = hashSeed(`${playerId}:${tier}:${today}`);
  const rng = mulberry32(seed);

  const [minFaster, maxFaster] = TIER_FASTER[tier];
  const fasterCount = minFaster + Math.floor(rng() * (maxFaster - minFaster + 1));
  const slowerCount = 9 - fasterCount;

  const entries: { label: string; timeMs: number }[] = [];

  const [fastLo, fastHi] = TIER_FAST_RANGE[tier];
  const [slowLo, slowHi] = TIER_SLOW_RANGE[tier];

  // Generate faster entries anchored to the reference (baseline) time
  for (let i = 0; i < fasterCount; i++) {
    const t = fasterCount === 1 ? 0.5 : i / (fasterCount - 1);
    const mult = fastLo + t * (fastHi - fastLo);
    const jitter = 1 + (rng() - 0.5) * 0.04;
    entries.push({
      label: ARCADE_INITIALS[Math.floor(rng() * ARCADE_INITIALS.length)],
      timeMs: Math.round(refTime * mult * jitter),
    });
  }

  // Generate slower entries anchored to the reference (baseline) time
  for (let i = 0; i < slowerCount; i++) {
    const t = slowerCount === 1 ? 0.5 : i / (slowerCount - 1);
    const mult = slowLo + t * (slowHi - slowLo);
    const jitter = 1 + (rng() - 0.5) * 0.04;
    entries.push({
      label: ARCADE_INITIALS[Math.floor(rng() * ARCADE_INITIALS.length)],
      timeMs: Math.round(refTime * mult * jitter),
    });
  }

  // Sort all entries + player by time
  const all: BoardEntry[] = entries
    .map((e) => ({ ...e, rank: 0, isPlayer: false }))
    .concat({ label: 'YOU', timeMs: playerTimeMs, rank: 0, isPlayer: true });

  all.sort((a, b) => a.timeMs - b.timeMs);
  for (let i = 0; i < all.length; i++) {
    all[i].rank = i + 1;
  }

  return all;
}

// ── Progress persistence ──────────────────────────────────────────

function getPlayerId(): string {
  const key = 'argus-bio-player-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Progress;
      if (p.playerId && p.currentTier) return p;
    }
  } catch {
    /* ignore */
  }
  return { playerId: getPlayerId(), currentTier: 'city', bestByTier: {}, baselineByTier: {} };
}

export function saveProgress(p: Progress): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

export function getNextTier(tier: Tier): Tier | null {
  const idx = TIERS.indexOf(tier);
  return idx < TIERS.length - 1 ? TIERS[idx + 1] : null;
}
