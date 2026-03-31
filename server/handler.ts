// server/handler.ts
// Lambda handler for biometric classification API

import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'crypto';
import { inflateRawSync } from 'zlib';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { QdrantClient } from './qdrant-client';
import { encode, EMBEDDING_VERSION, EMBEDDING_DIMS } from './embedding';
import { heuristicLabel, timingCV } from './heuristics';
import { classify, K } from './classifier';
import { lookupMerchantBySecret, validateReturnUrl } from './merchants';
import { createSession, getSession, completeSession } from './sessions';
import { createToken, redeemToken } from './tokens';
import type { BiometricPayload, Verdict, ClassifyResponse, Merchant } from './types';
import { MASK_WIDTH, MASK_HEIGHT } from './glyph-masks';
import { generateDynamicImage } from './dynamic-masks';
import { inferLetter } from './inference';
import { sboxApply } from './sbox';
import { redeemAndScore, PROBE_BOT_THRESHOLD, PROBE_ENFORCE } from './sigint';

const logger = new Logger();
const metrics = new Metrics();

const COLLECTION_NAME = `bio-handwriting-${EMBEDDING_VERSION}`;
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

// Glyph pool — letters only (server validates via EMNIST inference)
// type union kept for backward compat with in-flight encrypted challenges
interface ServerGlyph {
  char: string;
  type: 'digit' | 'letter';
  modelIndex: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERVER_GLYPH_POOL: ServerGlyph[] = [
  // Excluded: D (too similar to O), Q (too similar to O), V (too similar to U)
  ...[
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
  ].map((ch) => ({
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

// ── ECDH payload encryption ──────────────────────────────────────────
// Server ECDH keys loaded from SSM Parameter Store with 30-min cache.
// Used for key exchange in /v1/challenge and payload decryption in /v1/classify.

interface EcdhKeyData {
  privateKey: string;
  publicKey: string;
  rawPublicKey: string;
  createdAt: number;
}

interface EcdhKeys {
  current: EcdhKeyData;
  previous?: EcdhKeyData;
}

const ssmClient = new SSMClient({});
let cachedEcdhKeys: EcdhKeys | null = null;
let ecdhKeysLoadedAt = 0;
const ECDH_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function loadEcdhKeyPair(): Promise<EcdhKeys | null> {
  const paramName = process.env.ECDH_KEY_PARAM;
  if (!paramName) return null;

  if (cachedEcdhKeys && Date.now() - ecdhKeysLoadedAt < ECDH_CACHE_TTL_MS) {
    return cachedEcdhKeys;
  }

  try {
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true })
    );
    const parsed = JSON.parse(result.Parameter?.Value || '{}');
    if (!parsed.current) return null;
    cachedEcdhKeys = parsed as EcdhKeys;
    ecdhKeysLoadedAt = Date.now();
    return cachedEcdhKeys;
  } catch (err) {
    logger.warn('Failed to load ECDH keys from SSM', { error: err });
    return cachedEcdhKeys; // return stale cache if available
  }
}

const HKDF_INFO = new TextEncoder().encode('argus-bio-v1');

/** Derive an AES-256-GCM key from ECDH shared secret + HKDF with a date salt */
async function deriveAesKeyServer(
  serverPrivKeyPkcs8: string,
  clientPubKeyRaw: string,
  dateSalt: string,
  usages: ('encrypt' | 'decrypt')[] = ['decrypt']
) {
  // Import server private key (PKCS8 base64)
  const privBytes = Buffer.from(serverPrivKeyPkcs8, 'base64');
  const serverPrivKey = await crypto.subtle.importKey(
    'pkcs8',
    privBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );

  // Import client raw public key (65 bytes with 04 prefix)
  const pubBytes = Buffer.from(clientPubKeyRaw, 'base64');
  const clientPubKey = await crypto.subtle.importKey(
    'raw',
    pubBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // ECDH → 256-bit shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey },
    serverPrivKey,
    256
  );

  // HKDF → AES-256-GCM key
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const salt = new TextEncoder().encode(dateSalt);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** Encrypt an object as AES-256-GCM using the ECDH shared secret.
 *  Returns base64 string of [iv(12) | ciphertext+tag]. */
async function encryptForClient(
  data: object,
  serverPrivKey: string,
  clientPubKey: string
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const aesKey = await deriveAesKeyServer(serverPrivKey, clientPubKey, today, ['encrypt']);

  const plaintext = sboxApply(new TextEncoder().encode(JSON.stringify(data)));
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);

  const ct = Buffer.from(ciphertext);
  return Buffer.concat([iv, ct]).toString('base64');
}

/** Decrypt an encrypted biometric payload (octet-stream body).
 *  Tries current key first, falls back to previous for in-flight rotation.
 *  For each key, tries today's date salt first, then yesterday's (midnight edge case). */
async function decryptPayload(
  body: string,
  isBase64Encoded: boolean,
  clientPubKey: string,
  ecdhKeys: EcdhKeys
): Promise<BiometricPayload | null> {
  // Decode binary body → split iv (12 bytes) + ciphertext+tag
  const packed = isBase64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf-8');
  const iv = packed.subarray(0, 12);
  const ciphertextWithTag = packed.subarray(12);

  const keySets = [ecdhKeys.current, ecdhKeys.previous].filter((k): k is EcdhKeyData => k != null);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = [today, yesterday];

  for (const keySet of keySets) {
    for (const dateSalt of dates) {
      try {
        const aesKey = await deriveAesKeyServer(keySet.privateKey, clientPubKey, dateSalt);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          aesKey,
          ciphertextWithTag
        );
        const inflated = inflateRawSync(Buffer.from(decrypted));
        return JSON.parse(inflated.toString('utf-8')) as BiometricPayload;
      } catch {
        continue; // try next key/date combo
      }
    }
  }

  return null;
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Canvas-Fp',
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
  'GET /health': async () => jsonResponse(200, { status: 'ok', timestamp: Date.now() }),
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
  // Warmer ping from EventBridge — exit immediately
  if (!(event as unknown as Record<string, unknown>).requestContext) {
    return { statusCode: 200, body: 'warm' };
  }

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
async function parseAndAuth(
  event: APIGatewayProxyEventV2
): Promise<
  | { ok: false; error: APIGatewayProxyResultV2 }
  | { ok: true; body: Record<string, unknown>; merchant: Merchant }
> {
  const bodyOrError = safeParseBody(event);
  if (isErrorResponse(bodyOrError)) return { ok: false, error: bodyOrError };

  const secret = bodyOrError.secret as string | undefined;
  if (!secret) return { ok: false, error: jsonResponse(400, { error: 'Missing secret' }) };

  const merchant = await lookupMerchantBySecret(secret);
  if (!merchant) {
    logger.warn('Invalid API key', { prefix: secret.slice(0, 8) });
    return { ok: false, error: jsonResponse(401, INVALID_API_KEY) };
  }

  return { ok: true, body: bodyOrError, merchant };
}

async function handleChallenge(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const mode = event.queryStringParameters?.mode;
  const sid = event.queryStringParameters?.sid;

  // If a session ID is provided, validate it before generating a challenge
  if (sid) {
    const session = await getSession(sid);
    if (!session) return jsonResponse(404, { error: 'Session not found' });
    if (session.status !== 'pending') return jsonResponse(409, { error: 'Session already used' });
  }

  const glyphs = generateServerChallenge();
  let challengeId = encryptChallenge(glyphs, Date.now(), mode);

  // Send dynamically generated 8-bit grayscale images instead of static glyph templates.
  // Each image uses a random font + rotation/scale/jitter/elastic deformation + anti-aliased
  // edges, background noise, and intensity variation. Defeats template matching and forces OCR.
  const images = glyphs.map((g) => generateDynamicImage(g.char));

  // ECDH key exchange: if client sent its public key, append server's public key to challengeId
  // and encrypt the image data so bots can't sniff bitmaps off the wire.
  const clientPubKey = event.headers?.['x-canvas-fp'];
  if (clientPubKey) {
    const ecdhKeys = await loadEcdhKeyPair();
    if (ecdhKeys) {
      challengeId += ecdhKeys.current.rawPublicKey;

      try {
        // Encrypt images with ECDH shared secret
        const enc = await encryptForClient(
          { images, width: MASK_WIDTH, height: MASK_HEIGHT },
          ecdhKeys.current.privateKey,
          clientPubKey
        );
        return jsonResponse(200, { challengeId, enc });
      } catch (err) {
        logger.warn('Challenge encryption failed, falling back to plaintext', { error: err });
        // Fall through to plaintext response
      }
    }
  }

  // Fallback: no ECDH — send plaintext (local dev / key load failure)
  return jsonResponse(200, {
    challengeId,
    images,
    width: MASK_WIDTH,
    height: MASK_HEIGHT,
  });
}

/** Server-side inference: accept if expected letter is in model's top K predictions. */
const TOP_K = 5;

/** Validate challenge answers against server-side ground truth.
 *  Returns a retry response on mismatch, plus per-letter server confidence scores. */
function validateChallengeAnswers(payload: BiometricPayload): {
  retry: APIGatewayProxyResultV2 | null;
  scores: number[];
} {
  const decrypted = decryptChallenge(payload.challengeId, Date.now());
  if (!decrypted) return { retry: null, scores: [] }; // Non-challenge UUID — skip validation

  const { glyphs: expected, mode } = decrypted;
  const mismatches: string[] = [];
  const scores: number[] = [];
  const checkLen = Math.min(expected.length, payload.digits.length);

  for (let i = 0; i < checkLen; i++) {
    const exp = expected[i];
    const digit = payload.digits[i];
    if (!digit) {
      mismatches.push(`glyph[${i}]: missing`);
      scores.push(0);
      continue;
    }
    if (!digit.imageData || digit.imageData.length !== 784) {
      mismatches.push(`glyph[${i}]: missing or invalid imageData`);
      scores.push(0);
      continue;
    }
    const result = inferLetter(digit.imageData);
    const serverConf = result.allConfidences[exp.modelIndex] ?? 0;
    scores.push(serverConf);

    // Accept if expected letter is in model's top K predictions
    const indexed = result.allConfidences.map((c, idx) => ({ idx, c }));
    indexed.sort((a, b) => b.c - a.c);
    const topK = indexed.slice(0, TOP_K).map((e) => e.idx);

    if (!topK.includes(exp.modelIndex)) {
      const serverTop = LETTERS[result.index];
      mismatches.push(
        `glyph[${i}]: expected ${exp.char} not in server top-${TOP_K} (top=${serverTop}, conf=${(serverConf * 100).toFixed(1)}%)`
      );
    }
  }

  if (mismatches.length === 0) return { retry: null, scores };

  // Diagnostic: log imageData statistics to debug blank-image failures
  const imageStats = payload.digits.slice(0, checkLen).map((d, i) => {
    if (!d?.imageData) return { i, len: 0, sum: 0, max: 0, nonZero: 0 };
    const arr = d.imageData;
    let sum = 0,
      max = 0,
      nonZero = 0;
    for (let j = 0; j < arr.length; j++) {
      const v = arr[j];
      sum += v;
      if (v > max) max = v;
      if (v > 0) nonZero++;
    }
    return { i, len: arr.length, sum, max, nonZero };
  });

  logger.info('Challenge answer mismatch — retry', {
    challengeId: payload.challengeId.slice(0, 30),
    mode: mode ?? 'captcha',
    mismatches,
    imageStats,
    digitCount: payload.digits.length,
    expectedCount: expected.length,
  });
  return {
    retry: jsonResponse(200, {
      retry: true,
      message: 'Incorrect. Try again.',
    }),
    scores,
  };
}

/** Parse the classify request body — encrypted (octet-stream) or plain JSON. */
async function parseClassifyBody(
  event: APIGatewayProxyEventV2
): Promise<unknown | APIGatewayProxyResultV2> {
  const contentType = event.headers?.['content-type'] ?? '';

  if (contentType.includes('application/octet-stream')) {
    const clientPubKey = event.headers?.['x-canvas-fp'];
    const ecdhKeys = await loadEcdhKeyPair();
    if (!ecdhKeys || !clientPubKey) {
      return jsonResponse(400, { error: 'Encryption not configured' });
    }
    const decrypted = await decryptPayload(
      event.body ?? '',
      event.isBase64Encoded,
      clientPubKey,
      ecdhKeys
    );
    return decrypted ?? jsonResponse(400, { error: 'Decryption failed' });
  }

  // Plain JSON path (backwards compat)
  try {
    return parseBody(event);
  } catch {
    return jsonResponse(400, INVALID_JSON);
  }
}

/** Detect JA4 TLS fingerprint / User-Agent mismatch.
 *  JA4 section A encodes cipher count which differs by TLS library:
 *  Safari (SecureTransport): 24+ ciphers, Chrome (BoringSSL): 15-17, Firefox (NSS): 17-19.
 *  Returns a reason string on mismatch, null if OK or indeterminate. */
function detectJa4UaMismatch(ja4: string, ua: string): string | null {
  // JA4 format: t13d1516h2_hashB_hashC
  // Section A: proto(1) + tls(2) + sni(1) + ciphers(2) + exts(2) + alpn(2+)
  const sectionA = ja4.split('_')[0];
  if (!sectionA || sectionA.length < 8) return null;

  const nCiphers = parseInt(sectionA.substring(4, 6), 10);
  if (isNaN(nCiphers)) return null;

  const uaSaysSafari =
    /Safari/i.test(ua) && /iPhone|iPad|Macintosh/i.test(ua) && !/Chrome|CriOS/i.test(ua);
  const uaSaysFirefox = /Firefox/i.test(ua);

  // Safari (SecureTransport): 24+ ciphers. Chrome (BoringSSL): 15-17.
  if (uaSaysSafari && nCiphers < 12) return `safari-ua-but-${nCiphers}-ciphers`;
  if (uaSaysFirefox && nCiphers < 12) return `firefox-ua-but-${nCiphers}-ciphers`;

  return null;
}

interface TrainingContext {
  client: QdrantClient;
  embedding: number[];
  result: { verdict: string };
  hResult: { label: string; reason: string };
  payload: BiometricPayload;
  ja4: string | undefined;
}

/** Upsert a training vector if under the training cap. */
async function maybeUpsertTraining(ctx: TrainingContext): Promise<boolean> {
  const { client, embedding, result, hResult, payload, ja4 } = ctx;
  if (cachedPointCount === null) {
    const info = await client.collectionInfo(COLLECTION_NAME);
    cachedPointCount = info.points_count;
  }
  if (cachedPointCount >= TRAINING_CAP) return false;

  await client.upsert(COLLECTION_NAME, {
    points: [
      {
        id: crypto.randomUUID(),
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
          ja4: ja4 ?? 'missing',
          heuristicLabel: hResult.label,
          heuristicReason: hResult.reason,
        },
      },
    ],
  });
  cachedPointCount++;
  return true;
}

/** Handle session token creation if sessionId is present. */
async function maybeCreateSessionToken(
  payload: BiometricPayload,
  verdict: Verdict,
  confidence: number
): Promise<APIGatewayProxyResultV2 | { token: string; returnUrl: string } | null> {
  const sessionId = (payload as unknown as Record<string, unknown>).sessionId as string | undefined;
  if (!sessionId) return null;

  const session = await getSession(sessionId);
  if (!session) return jsonResponse(404, { error: 'Session not found' });
  if (session.status !== 'pending') return jsonResponse(409, { error: 'Session already used' });

  const token = await createToken(
    sessionId,
    session.merchantId,
    verdict.verdict,
    Math.round(confidence * 1000) / 1000
  );
  await completeSession(sessionId);
  return { token: token.token, returnUrl: session.returnUrl };
}

/** Check JA4/UA mismatch and return a retry response if detected, null otherwise. */
function checkJa4Mismatch(ja4: string | undefined, ua: string): APIGatewayProxyResultV2 | null {
  if (!ja4) return null;
  const mismatch = detectJa4UaMismatch(ja4, ua);
  if (!mismatch) return null;
  logger.warn('JA4/UA mismatch', { ja4, ua: ua.substring(0, 100), reason: mismatch });
  return jsonResponse(200, { retry: true, message: 'Incorrect. Try again.' });
}

interface BotCheckResult {
  block: APIGatewayProxyResultV2 | null;
  ja4: string | undefined;
  probeScore: number;
  probeSignals: string[];
}

/** Run all bot signal checks (JA4 + sigint probes). Returns block response or null. */
async function runBotChecks(
  payload: BiometricPayload,
  event: APIGatewayProxyEventV2
): Promise<BotCheckResult> {
  const ja4 = event.headers?.['cloudfront-viewer-ja4-fingerprint'];
  const ja4Block = checkJa4Mismatch(ja4, event.headers?.['user-agent'] ?? '');
  if (ja4Block) return { block: ja4Block, ja4, probeScore: 0, probeSignals: [] };

  const clientIp =
    (event.headers?.['cloudfront-viewer-address'] ?? '').split(':')[0] ||
    (event.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  const probe = await redeemAndScore({
    tcpToken: payload.tcpProbeToken,
    h2Token: payload.h2ProbeToken,
    userAgent: event.headers?.['user-agent'] ?? payload.userAgent,
    classifyClientIp: clientIp,
  });
  if (probe.score >= PROBE_BOT_THRESHOLD) {
    logger.warn('Sigint probe bot detected', {
      score: probe.score,
      signals: probe.signals,
      ja4,
      enforcing: PROBE_ENFORCE,
    });
    return {
      block: PROBE_ENFORCE
        ? jsonResponse(200, { retry: true, message: 'Incorrect. Try again.' })
        : null,
      ja4,
      probeScore: probe.score,
      probeSignals: probe.signals,
    };
  }
  return { block: null, ja4, probeScore: probe.score, probeSignals: probe.signals };
}

async function handleClassify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const start = Date.now();

  try {
    const payload = await parseClassifyBody(event);
    if (isErrorResponse(payload)) return payload;

    if (!validatePayload(payload)) {
      return jsonResponse(400, { error: 'Invalid payload structure' });
    }

    // Bot signal checks: JA4/UA mismatch + sigint probe token scoring.
    // Probe tokens were collected during ECDH encryption on the client,
    // so DynamoDB redemption here adds no perceptible latency.
    const botCheck = await runBotChecks(payload, event);
    if (botCheck.block) return botCheck.block;

    // Server-side answer validation — returns retry response on mismatch
    const { retry: retryResponse, scores } = validateChallengeAnswers(payload);
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

    const trained = await maybeUpsertTraining({
      client,
      embedding,
      result,
      hResult,
      payload,
      ja4: botCheck.ja4,
    });

    const verdict: Verdict = {
      verdict: result.verdict,
      challengeId: payload.challengeId,
    };

    // Score: average server-side EMNIST confidence (0-100)
    const score =
      scores.length > 0
        ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100)
        : undefined;

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
      vmHash: payload.vmHash ?? 'missing',
      ja4: botCheck.ja4 ?? 'missing',
      probeScore: botCheck.probeScore,
      probeSignals: botCheck.probeSignals,
    });

    // Mask bot verdict — return same retry response as wrong answers
    // so bots can't distinguish detection from misrecognition
    if (result.verdict === 'bot') {
      return jsonResponse(200, { retry: true, message: 'Incorrect. Try again.' });
    }

    const response: ClassifyResponse = { ...verdict, score };

    const sessionResult = await maybeCreateSessionToken(payload, verdict, result.confidence);
    if (isErrorResponse(sessionResult)) return sessionResult;
    if (sessionResult) {
      response.token = sessionResult.token;
      response.returnUrl = sessionResult.returnUrl;
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
    if (!auth.ok) return auth.error;
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
    if (!auth.ok) return auth.error;
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
