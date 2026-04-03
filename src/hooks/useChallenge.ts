import { useState, useCallback, useRef, useEffect } from 'react';
import {
  buildClientImage,
  mask1bitTo8bit,
  CLIENT_IMAGE_WIDTH,
  CLIENT_IMAGE_HEIGHT,
} from '../utils/mask';
import { extractServerKey } from '../utils/crypto';
import { initCrypto, workerDecrypt } from '../utils/crypto-worker-client';
import { measureAsync } from '../utils/perf';
import { isEmbedded } from '../utils/embed';
import { API_URL, MSG_ERROR } from '../constants';

// Eagerly start ECDH key generation so it's ready before first fetchChallenge
const cryptoReady = API_URL ? initCrypto() : null;

export interface Glyph {
  /** Base64-encoded 8-bit grayscale image from the server */
  image: string;
}

// ── Fallback for local dev without API ──────────────────────────────
// Excluded: D (too similar to O), Q (too similar to O), V (too similar to U)
const FALLBACK_LETTERS = [
  'A',
  'B',
  'C',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'R',
  'S',
  'T',
  'U',
  'W',
  'X',
  'Y',
  'Z',
];

function generateFallbackChallenge(): Glyph[] {
  const len = 3 + Math.floor(Math.random() * 2); // 3 or 4
  const unique: string[] = [];
  const used = new Set<string>();
  while (unique.length < len - 1) {
    const ch = FALLBACK_LETTERS[Math.floor(Math.random() * FALLBACK_LETTERS.length)];
    if (!used.has(ch)) {
      used.add(ch);
      unique.push(ch);
    }
  }
  const repeatIdx = Math.floor(Math.random() * unique.length);
  const all = [...unique, unique[repeatIdx]];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.map((ch) => ({ image: buildClientImage(ch) }));
}

export interface UseChallengeResult {
  challenge: Glyph[];
  challengeRef: React.MutableRefObject<Glyph[]>;
  imageDims: { w: number; h: number };
  sessionError: string | null;
  challengeIdRef: React.MutableRefObject<string>;
  rawPublicKeyRef: React.MutableRefObject<string>;
  serverPubKeyRef: React.MutableRefObject<string>;
  sessionIdRef: React.MutableRefObject<string | null>;
  /** Fetch a new challenge and update internal state. */
  reload: () => Promise<void>;
}

export function useChallenge(onReady?: () => void): UseChallengeResult {
  const onReadyRef = useRef(onReady);
  const [challenge, setChallenge] = useState<Glyph[]>([]);
  const [imageDims, setImageDims] = useState({ w: CLIENT_IMAGE_WIDTH, h: CLIENT_IMAGE_HEIGHT });
  const [sessionError, setSessionError] = useState<string | null>(null);

  const challengeRef = useRef<Glyph[]>([]);
  const challengeIdRef = useRef<string>('');
  const rawPublicKeyRef = useRef<string>('');
  const serverPubKeyRef = useRef<string>('');
  const sessionIdRef = useRef<string | null>(
    new URLSearchParams(window.location.search).get('sid')
  );

  /** Fetch a challenge from the server, or fall back to client-side generation.
   *  Also performs ECDH key exchange: sends client pubkey, extracts server pubkey. */
  const fetchChallenge = useCallback(async (): Promise<Glyph[]> => {
    if (!API_URL) return generateFallbackChallenge();
    try {
      // Use eagerly-started crypto or reuse from previous round
      if (!rawPublicKeyRef.current) {
        const { rawPublicKey } = await measureAsync(
          'crypto:init',
          () => cryptoReady ?? initCrypto()
        );
        rawPublicKeyRef.current = rawPublicKey;
      }

      const headers: Record<string, string> = {};
      if (rawPublicKeyRef.current) {
        headers['X-Canvas-Fp'] = rawPublicKeyRef.current;
      }

      const challengeParams = new URLSearchParams();
      if (sessionIdRef.current) challengeParams.set('sid', sessionIdRef.current);
      const challengeQs = challengeParams.toString();
      const data = await measureAsync('fetch:challenge', async () => {
        const res = await fetch(`${API_URL}/v1/challenge${challengeQs ? `?${challengeQs}` : ''}`, {
          headers,
        });
        return res.json();
      });

      if (data.error) {
        setSessionError(data.error);
        if (isEmbedded()) {
          window.parent.postMessage({ type: MSG_ERROR, error: data.error }, '*');
        }
        return [];
      }

      // Extract server's public key appended to challengeId
      const extracted = extractServerKey(data.challengeId as string);
      challengeIdRef.current = extracted.challengeId;
      if (extracted.serverPubKey) {
        serverPubKeyRef.current = extracted.serverPubKey;
      }

      // Decrypt or read plaintext challenge data.
      // Handles both new format (8-bit images) and old format (1-bit masks).
      let images: string[];
      let dims: { w: number; h: number };
      if (data.enc && rawPublicKeyRef.current && extracted.serverPubKey) {
        const decrypted = await measureAsync('crypto:decrypt-challenge', () =>
          workerDecrypt(data.enc as string, extracted.serverPubKey)
        );
        if ('images' in decrypted) {
          images = decrypted.images;
          dims = { w: decrypted.width, h: decrypted.height };
        } else {
          // Old server format — convert 1-bit masks to 8-bit images
          images = decrypted.masks.map((m) =>
            mask1bitTo8bit(m, decrypted.maskWidth, decrypted.maskHeight)
          );
          dims = { w: decrypted.maskWidth, h: decrypted.maskHeight };
        }
      } else if (Array.isArray(data.images)) {
        images = data.images as string[];
        dims = { w: data.width, h: data.height };
      } else {
        // Old plaintext format
        images = (data.masks as string[]).map((m: string) =>
          mask1bitTo8bit(m, data.maskWidth, data.maskHeight)
        );
        dims = { w: data.maskWidth, h: data.maskHeight };
      }
      const result = images.map((image) => ({ image }));
      setImageDims(dims);
      return result;
    } catch {
      challengeIdRef.current = '';
      return generateFallbackChallenge();
    }
  }, []);

  // Fetch challenge on mount; call onReady after the async load completes
  useEffect(() => {
    void (async () => {
      const c = await fetchChallenge();
      setChallenge(c);
      challengeRef.current = c;
      onReadyRef.current?.();
    })();
  }, [fetchChallenge]);

  const reload = useCallback(async (): Promise<void> => {
    const c = await fetchChallenge();
    setChallenge(c);
    challengeRef.current = c;
  }, [fetchChallenge]);

  return {
    challenge,
    challengeRef,
    imageDims,
    sessionError,
    challengeIdRef,
    rawPublicKeyRef,
    serverPubKeyRef,
    sessionIdRef,
    reload,
  };
}
