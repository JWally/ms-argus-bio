// server/handler.ts
// Lambda handler for biometric classification API

import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { QdrantClient } from './qdrant-client';
import { encode, EMBEDDING_VERSION, EMBEDDING_DIMS } from './embedding';
import { heuristicLabel, timingCV } from './heuristics';
import { classify, K } from './classifier';
import { lookupMerchantBySecret, validateReturnUrl } from './merchants';
import { createSession, getSession, completeSession } from './sessions';
import { createToken, redeemToken } from './tokens';
import type { BiometricPayload, Verdict, ClassifyResponse } from './types';
import { GLYPH_MASKS, MASK_WIDTH, MASK_HEIGHT } from './glyph-masks';

const logger = new Logger();
const metrics = new Metrics();

const COLLECTION_NAME = 'bio-handwriting';
const INTERNAL_ERROR = { error: 'Internal server error' };
const INVALID_JSON = { error: 'Invalid JSON' };
const INVALID_API_KEY = { error: 'Invalid API key' };

// ── Server-side challenge generation ────────────────────────────────
// Encryption key: generated per Lambda container cold-start. Persists for the
// container's lifetime (15min-hours), well beyond the 5-minute challenge TTL.
const CHALLENGE_SECRET = process.env.CHALLENGE_HMAC_SECRET ?? randomBytes(32).toString('hex');
// Derive a 32-byte key for AES-256-GCM (works even if env var isn't hex)
const CHALLENGE_KEY = createHmac('sha256', CHALLENGE_SECRET).update('challenge-key').digest();
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Glyph pool — mirrors the client-side pool in CaptchaPage.tsx
interface ServerGlyph {
  char: string;
  type: 'digit' | 'letter';
  modelIndex: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERVER_GLYPH_POOL: ServerGlyph[] = [
  ...[2, 3, 4, 7].map((d) => ({
    char: String(d),
    type: 'digit' as const,
    modelIndex: d,
  })),
  ...['A', 'C', 'E', 'F', 'H', 'J', 'K', 'M', 'N', 'P', 'R', 'T', 'W', 'X', 'Y'].map((ch) => ({
    char: ch,
    type: 'letter' as const,
    modelIndex: LETTERS.indexOf(ch),
  })),
];

function generateServerChallenge(): ServerGlyph[] {
  const len = 3 + Math.floor(Math.random() * 2); // 3 or 4
  const unique: ServerGlyph[] = [];
  const used = new Set<string>();
  while (unique.length < len - 1) {
    const g = SERVER_GLYPH_POOL[Math.floor(Math.random() * SERVER_GLYPH_POOL.length)];
    if (!used.has(g.char)) {
      used.add(g.char);
      unique.push(g);
    }
  }
  const repeatIdx = Math.floor(Math.random() * unique.length);
  const all = [...unique, unique[repeatIdx]];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

const T3_LETTER_POOL = SERVER_GLYPH_POOL.filter((g) => g.type === 'letter');
const T3_NUM_TARGETS = 5; // max human turns in tic-tac-toe

function generateT3Challenge(): ServerGlyph[] {
  const glyphs: ServerGlyph[] = [];
  const used = new Set<string>();
  while (glyphs.length < T3_NUM_TARGETS) {
    const g = T3_LETTER_POOL[Math.floor(Math.random() * T3_LETTER_POOL.length)];
    if (!used.has(g.char)) {
      used.add(g.char);
      glyphs.push(g);
    }
  }
  return glyphs;
}

/** Encrypt challenge glyphs + timestamp into an opaque token (AES-256-GCM).
 *  The client carries this blob and sends it back on classify.
 *  Only the server can decrypt it — client never sees the expected answer. */
function encryptChallenge(glyphs: ServerGlyph[], timestamp: number, mode?: string): string {
  const plaintext = JSON.stringify({
    g: glyphs.map((g) => ({ t: g.type[0], i: g.modelIndex })),
    ts: timestamp,
    ...(mode ? { m: mode } : {}),
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', CHALLENGE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv (12) + tag (16) + ciphertext → base64url
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

interface DecryptedChallenge {
  glyphs: ServerGlyph[];
  mode?: string;
}

/** Decrypt a challengeId token. Returns the expected glyphs + mode or null on failure. */
function decryptChallenge(challengeId: string, now: number): DecryptedChallenge | null {
  try {
    const buf = Buffer.from(challengeId, 'base64url');
    if (buf.length < 29) return null; // 12 iv + 16 tag + 1 min ciphertext

    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', CHALLENGE_KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8'
    );

    const data = JSON.parse(plaintext) as {
      g: { t: string; i: number }[];
      ts: number;
      m?: string;
    };

    // Check TTL
    if (now - data.ts > CHALLENGE_TTL_MS) return null;

    const glyphs = data.g.map((item) => {
      const type = item.t === 'd' ? 'digit' : 'letter';
      const glyph = SERVER_GLYPH_POOL.find((g) => g.type === type && g.modelIndex === item.i);
      return glyph ?? { char: '?', type: type as 'digit' | 'letter', modelIndex: item.i };
    });

    return { glyphs, mode: data.m };
  } catch {
    return null;
  }
}

/** Stop upserting new training vectors once collection reaches this size */
const TRAINING_CAP = 1000;

// Module-scope singletons (reused across warm invocations)
let qdrantClient: QdrantClient | null = null;
let collectionReady = false;

/** Cached point count — avoids extra Qdrant round-trip once training is done */
let cachedPointCount: number | null = null;

function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    const baseUrl = process.env.QDRANT_URL;
    const secretArn = process.env.QDRANT_SECRET_ARN;
    if (!baseUrl || !secretArn) {
      throw new Error('QDRANT_URL and QDRANT_SECRET_ARN must be set');
    }
    qdrantClient = new QdrantClient({ baseUrl, secretArn, logger });
  }
  return qdrantClient;
}

async function ensureCollection(client: QdrantClient): Promise<void> {
  if (collectionReady) return;
  const exists = await client.collectionExists(COLLECTION_NAME);
  if (!exists) {
    logger.info('Creating collection', { collection: COLLECTION_NAME });
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIMS, distance: 'Cosine' },
    });
  }
  collectionReady = true;
}

function cors(response: APIGatewayProxyResultV2): APIGatewayProxyResultV2 {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...(typeof response === 'object' && 'headers' in response
      ? (response.headers as Record<string, string>)
      : {}),
  };
  if (typeof response === 'object' && 'statusCode' in response) {
    return { ...response, headers };
  }
  return response;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return cors({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line complexity
function validatePayload(data: unknown): data is BiometricPayload {
  if (!data || typeof data !== 'object') return false;
  const p = data as Record<string, unknown>;
  return (
    typeof p.challengeId === 'string' &&
    Array.isArray(p.challenge) &&
    typeof p.timestamp === 'number' &&
    typeof p.completionTimeMs === 'number' &&
    typeof p.passed === 'boolean' &&
    Array.isArray(p.digits) &&
    Array.isArray(p.confidenceTimeline) &&
    typeof p.inputType === 'string' &&
    typeof p.screenWidth === 'number' &&
    typeof p.screenHeight === 'number' &&
    typeof p.devicePixelRatio === 'number' &&
    typeof p.userAgent === 'string' &&
    typeof p.features === 'object' &&
    p.features !== null
  );
}

type RouteHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

const routes: Record<string, RouteHandler> = {
  'GET /health': () => jsonResponse(200, { status: 'ok', timestamp: Date.now() }),
  'GET /v1/challenge': handleChallenge,
  'POST /v1/session': handleCreateSession,
  'POST /v1/classify': handleClassify,
  'POST /v1/verify': handleVerify,
  'POST /admin/flush': handleFlush,
  'GET /admin/stats': handleStats,
  'GET /admin/scroll': handleScroll,
  'POST /admin/relabel': handleRelabel,
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method === 'OPTIONS') {
    return cors({ statusCode: 204, body: '' });
  }

  const route = routes[`${method} ${event.rawPath}`];
  if (route) return route(event);

  return jsonResponse(404, { error: 'Not found' });
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  let bodyStr = event.body ?? '';
  if (event.isBase64Encoded) {
    bodyStr = Buffer.from(bodyStr, 'base64').toString('utf-8');
  }
  return JSON.parse(bodyStr);
}

/** Parse JSON body, returning 400 on bad JSON. */
function safeParseBody(
  event: APIGatewayProxyEventV2
): Record<string, unknown> | APIGatewayProxyResultV2 {
  try {
    return parseBody(event) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, INVALID_JSON);
  }
}

function isErrorResponse(v: unknown): v is APIGatewayProxyResultV2 {
  return typeof v === 'object' && v !== null && 'statusCode' in v;
}

/** Parse body and authenticate merchant by secret field. */
async function parseAndAuth(event: APIGatewayProxyEventV2) {
  const bodyOrError = safeParseBody(event);
  if (isErrorResponse(bodyOrError)) return { error: bodyOrError } as const;

  const secret = bodyOrError.secret as string | undefined;
  if (!secret) return { error: jsonResponse(400, { error: 'Missing secret' }) } as const;

  const merchant = await lookupMerchantBySecret(secret);
  if (!merchant) {
    logger.warn('Invalid API key', { prefix: secret.slice(0, 8) });
    return { error: jsonResponse(401, INVALID_API_KEY) } as const;
  }

  return { body: bodyOrError, merchant } as const;
}

/** Apply random bit-flip noise to a 1-bit packed mask (base64 → base64).
 *  Flips ~noiseRate fraction of bits to defeat template-matching attacks. */
function noisifyMask(b64: string, noiseRate = 0.03): string {
  const bytes = Buffer.from(b64, 'base64');
  const out = Buffer.from(bytes);
  const totalBits = MASK_WIDTH * MASK_HEIGHT;
  const flips = Math.round(totalBits * noiseRate);
  for (let f = 0; f < flips; f++) {
    const bit = Math.floor(Math.random() * totalBits);
    const byteIdx = Math.floor(bit / 8);
    const bitIdx = 7 - (bit % 8);
    out[byteIdx] ^= 1 << bitIdx;
  }
  return out.toString('base64');
}

async function handleChallenge(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const mode = event.queryStringParameters?.mode;
  const glyphs = mode === 't3' ? generateT3Challenge() : generateServerChallenge();
  const challengeId = encryptChallenge(glyphs, Date.now(), mode);

  // Send masks (with noise) instead of glyph characters.
  // The client never sees char or modelIndex — only the server can decrypt challengeId.
  const masks = glyphs.map((g) => noisifyMask(GLYPH_MASKS[g.char]));
  const types = glyphs.map((g) => g.type);

  return jsonResponse(200, {
    challengeId,
    masks,
    types,
    maskWidth: MASK_WIDTH,
    maskHeight: MASK_HEIGHT,
  });
}

/** Validate challenge answers against server-side ground truth.
 *  Returns null if valid, or a retry response if mismatched. */
function validateChallengeAnswers(payload: BiometricPayload): APIGatewayProxyResultV2 | null {
  const decrypted = decryptChallenge(payload.challengeId, Date.now());
  if (!decrypted) return null; // Non-challenge UUID — skip validation

  const { glyphs: expected, mode } = decrypted;
  const isT3 = mode === 't3';
  const T3_TOP_K = 5;
  const mismatches: string[] = [];
  const checkLen = Math.min(expected.length, payload.digits.length);

  for (let i = 0; i < checkLen; i++) {
    const exp = expected[i];
    const digit = payload.digits[i];
    if (!digit) {
      mismatches.push(`glyph[${i}]: missing`);
      continue;
    }
    if (isT3 && digit.allConfidences) {
      // T3: accept if expected letter is in model's top K predictions
      const indexed = digit.allConfidences.map((c, idx) => ({ idx, c }));
      indexed.sort((a, b) => b.c - a.c);
      const topK = indexed.slice(0, T3_TOP_K).map((e) => e.idx);
      if (!topK.includes(exp.modelIndex)) {
        const conf = digit.allConfidences[exp.modelIndex] ?? 0;
        mismatches.push(
          `glyph[${i}]: expected ${exp.char} not in top-${T3_TOP_K} (top=${LETTERS[indexed[0].idx]}, conf=${(conf * 100).toFixed(1)}%)`
        );
      }
    } else if (digit.recognized !== exp.modelIndex) {
      mismatches.push(
        `glyph[${i}]: expected ${exp.char}(${exp.modelIndex}) got ${digit.recognized}`
      );
    }
  }

  if (mismatches.length === 0) return null;

  logger.info('Challenge answer mismatch — retry', {
    challengeId: payload.challengeId.slice(0, 30),
    mode: mode ?? 'captcha',
    mismatches,
  });
  return jsonResponse(200, {
    retry: true,
    message:
      mismatches.length === 1
        ? 'One character was incorrect. Try again!'
        : `${mismatches.length} characters were incorrect. Try again!`,
  });
}

async function handleClassify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const start = Date.now();

  try {
    let payload: unknown;
    try {
      payload = parseBody(event);
    } catch {
      return jsonResponse(400, INVALID_JSON);
    }

    if (!validatePayload(payload)) {
      return jsonResponse(400, { error: 'Invalid payload structure' });
    }

    // Server-side answer validation — returns retry response on mismatch
    const retryResponse = validateChallengeAnswers(payload);
    if (retryResponse) return retryResponse;

    // Compute embedding
    const embedding = encode(payload);

    // Get Qdrant client and ensure collection
    const client = getQdrantClient();
    await ensureCollection(client);

    // Search for kNN neighbors
    const neighbors = await client.search(COLLECTION_NAME, {
      vector: embedding,
      limit: K,
      with_payload: true,
      score_threshold: 0.5,
    });

    // Apply heuristic label
    const hResult = heuristicLabel(payload);

    // Classify via kNN + heuristic fallback
    const result = classify(neighbors, hResult.label);

    // Check training cap — skip upsert once collection has enough vectors
    let trained = false;
    if (cachedPointCount === null) {
      const info = await client.collectionInfo(COLLECTION_NAME);
      cachedPointCount = info.points_count;
    }

    // ── Training data gating ──
    // Three guards prevent adversarial poisoning:
    // 1. Never store "uncertain" verdicts
    // 2. Heuristic must agree with kNN verdict (or cold-start with no neighbors)
    //    — prevents poisoned kNN from laundering bot submissions as "human"
    // 3. (near-duplicate check removed during training phase)
    const heuristicAgrees = hResult.label === result.verdict;
    const isColdStart = result.neighborCount === 0;
    if (
      cachedPointCount < TRAINING_CAP &&
      result.verdict !== 'uncertain' &&
      (heuristicAgrees || isColdStart)
    ) {
      const pointId = crypto.randomUUID();
      await client.upsert(COLLECTION_NAME, {
        points: [
          {
            id: pointId,
            vector: embedding,
            payload: {
              label: result.verdict,
              challengeId: payload.challengeId,
              timestamp: payload.timestamp,
              inputType: payload.inputType,
              passed: payload.passed,
              completionTimeMs: payload.completionTimeMs,
              embeddingVersion: EMBEDDING_VERSION,
              userAgent: payload.userAgent,
              heuristicLabel: hResult.label,
              heuristicReason: hResult.reason,
            },
          },
        ],
      });
      cachedPointCount++;
      trained = true;
    }

    const verdict: Verdict = {
      verdict: result.verdict,
      confidence: Math.round(result.confidence * 1000) / 1000,
      neighborCount: result.neighborCount,
      challengeId: payload.challengeId,
    };

    metrics.addMetric('ClassifyLatencyMs', MetricUnit.Milliseconds, Date.now() - start);
    metrics.addMetric('ClassifyRequest', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    logger.info('Classification complete', {
      challengeId: payload.challengeId,
      verdict: result.verdict,
      confidence: result.confidence,
      neighborCount: result.neighborCount,
      heuristicLabel: hResult.label,
      heuristicReason: hResult.reason,
      trained,
      pointCount: cachedPointCount,
      latencyMs: Date.now() - start,
      eventFrequencyHz: Math.round(payload.features.eventFrequencyHz * 100) / 100,
      totalPoints: payload.features.totalPoints,
      strokeCount: payload.features.strokeCount,
      completionTimeMs: Math.round(payload.completionTimeMs),
      passed: payload.passed,
      speedVariance: Math.round(payload.features.speedVariance * 10000) / 10000,
      timingCV: Math.round(timingCV(payload) * 1000) / 1000,
    });

    const response: ClassifyResponse & { heuristicLabel: string; heuristicReason: string } = {
      ...verdict,
      heuristicLabel: hResult.label,
      heuristicReason: hResult.reason,
    };

    // Session flow: create verification token and include returnUrl
    const sessionId = (payload as unknown as Record<string, unknown>).sessionId as
      | string
      | undefined;
    if (sessionId) {
      const session = await getSession(sessionId);
      if (!session) return jsonResponse(404, { error: 'Session not found' });
      if (session.status !== 'pending') return jsonResponse(409, { error: 'Session already used' });

      const token = await createToken(
        sessionId,
        session.merchantId,
        verdict.verdict,
        verdict.confidence
      );
      await completeSession(sessionId);

      response.token = token.token;
      response.returnUrl = session.returnUrl;
    }

    return jsonResponse(200, response);
  } catch (error) {
    logger.error('Classification failed', { error });
    metrics.addMetric('ClassifyError', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    return jsonResponse(500, INTERNAL_ERROR);
  }
}

async function handleCreateSession(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const auth = await parseAndAuth(event);
    if ('error' in auth) return auth.error;
    const { body, merchant } = auth;

    const returnUrl = body.returnUrl as string | undefined;
    if (!returnUrl) {
      return jsonResponse(400, { error: 'Missing returnUrl' });
    }

    if (!validateReturnUrl(merchant, returnUrl)) {
      return jsonResponse(403, { error: 'Return URL not allowed' });
    }

    const session = await createSession(merchant.merchantId, returnUrl);
    const siteDomain = process.env.SITE_DOMAIN;
    const captchaUrl = `https://${siteDomain}?sid=${session.sessionId}`;

    logger.info('Session created', {
      sessionId: session.sessionId,
      merchantId: merchant.merchantId,
    });

    return jsonResponse(200, { sessionId: session.sessionId, captchaUrl });
  } catch (error) {
    logger.error('Create session failed', { error });
    return jsonResponse(500, INTERNAL_ERROR);
  }
}

async function handleVerify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const auth = await parseAndAuth(event);
    if ('error' in auth) return auth.error;
    const { body, merchant } = auth;

    const response = body.response as string | undefined;
    if (!response) {
      return jsonResponse(400, { error: 'Missing response' });
    }

    const token = await redeemToken(response, merchant.merchantId);
    if (!token) {
      return jsonResponse(200, { success: false });
    }

    logger.info('Token redeemed', {
      sessionId: token.sessionId,
      merchantId: merchant.merchantId,
    });

    return jsonResponse(200, {
      success: true,
      verdict: token.verdict,
      confidence: token.confidence,
      sessionId: token.sessionId,
      timestamp: token.createdAt,
    });
  } catch (error) {
    logger.error('Verify failed', { error });
    return jsonResponse(500, INTERNAL_ERROR);
  }
}

async function handleFlush(): Promise<APIGatewayProxyResultV2> {
  try {
    const client = getQdrantClient();
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (exists) {
      await client.deleteCollection(COLLECTION_NAME);
    }
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIMS, distance: 'Cosine' },
    });
    collectionReady = true;
    cachedPointCount = 0;
    logger.info('Collection flushed', { collection: COLLECTION_NAME });
    return jsonResponse(200, { status: 'flushed', collection: COLLECTION_NAME });
  } catch (error) {
    logger.error('Flush failed', { error });
    return jsonResponse(500, { error: 'Flush failed' });
  }
}

async function handleScroll(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const client = getQdrantClient();
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (!exists) {
      return jsonResponse(200, { collection: COLLECTION_NAME, points: [], total: 0 });
    }

    const withVectors = event.queryStringParameters?.vectors === 'true';
    const allPoints: Array<{
      id: string | number;
      payload?: Record<string, unknown>;
      vector?: number[];
    }> = [];
    let offset: string | number | null = null;

    // Scroll through all points
    while (true) {
      const result = await client.scroll(COLLECTION_NAME, {
        limit: 100,
        offset,
        with_payload: true,
        with_vector: withVectors,
      });
      allPoints.push(...result.points);
      if (!result.next_page_offset) break;
      offset = result.next_page_offset;
    }

    return jsonResponse(200, {
      collection: COLLECTION_NAME,
      total: allPoints.length,
      points: allPoints,
    });
  } catch (error) {
    logger.error('Scroll failed', { error });
    return jsonResponse(500, { error: 'Scroll failed' });
  }
}

async function handleRelabel(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const bodyOrError = safeParseBody(event);
    if (isErrorResponse(bodyOrError)) return bodyOrError;

    const ids = bodyOrError.ids as string[];
    const label = bodyOrError.label as string;
    if (!Array.isArray(ids) || ids.length === 0 || typeof label !== 'string') {
      return jsonResponse(400, { error: 'Provide ids (string[]) and label (string)' });
    }

    const client = getQdrantClient();
    await client.setPayload(COLLECTION_NAME, { label }, ids);

    logger.info('Relabeled points', { count: ids.length, label });
    return jsonResponse(200, { relabeled: ids.length, label });
  } catch (error) {
    logger.error('Relabel failed', { error });
    return jsonResponse(500, { error: 'Relabel failed' });
  }
}

async function handleStats(): Promise<APIGatewayProxyResultV2> {
  try {
    const client = getQdrantClient();
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (!exists) {
      return jsonResponse(200, {
        collection: COLLECTION_NAME,
        points_count: 0,
        status: 'not_found',
      });
    }
    const info = await client.collectionInfo(COLLECTION_NAME);
    return jsonResponse(200, {
      collection: COLLECTION_NAME,
      ...info,
      trainingCap: TRAINING_CAP,
      trainingComplete: info.points_count >= TRAINING_CAP,
    });
  } catch (error) {
    logger.error('Stats failed', { error });
    return jsonResponse(500, { error: 'Stats failed' });
  }
}
