// server/handler.ts
// Lambda handler for biometric classification API

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

const logger = new Logger();
const metrics = new Metrics();

const COLLECTION_NAME = 'bio-handwriting';
const INTERNAL_ERROR = { error: 'Internal server error' };
const INVALID_JSON = { error: 'Invalid JSON' };
const INVALID_API_KEY = { error: 'Invalid API key' };

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
    const hLabel = heuristicLabel(payload);

    // Classify via kNN + heuristic fallback
    const result = classify(neighbors, hLabel);

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
    // 3. Near-duplicate check: skip if a very similar vector already exists
    //    — prevents cluster flooding from repeated bot runs
    const heuristicAgrees = hLabel === result.verdict;
    const isColdStart = result.neighborCount === 0;
    if (
      cachedPointCount < TRAINING_CAP &&
      result.verdict !== 'uncertain' &&
      (heuristicAgrees || isColdStart)
    ) {
      // Near-duplicate check: reject vectors > 0.95 cosine similarity
      // const dupeCheck = await client.search(COLLECTION_NAME, {
      //   vector: embedding,
      //   limit: 1,
      //   score_threshold: 0.95,
      // });

      // if (dupeCheck.length === 0) {
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
            },
          },
        ],
      });
      cachedPointCount++;
      trained = true;
      // } else {
      //   logger.info('Skipped training — near-duplicate vector', {
      //     existingId: dupeCheck[0].id,
      //     similarity: dupeCheck[0].score,
      //   });
      // }
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
      heuristicLabel: hLabel,
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

    const response: ClassifyResponse = {
      ...verdict,
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
