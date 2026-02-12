// server/handler.ts
// Lambda handler for biometric classification API

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { QdrantClient } from './qdrant-client';
import { encode, EMBEDDING_VERSION, EMBEDDING_DIMS } from './embedding';
import { heuristicLabel } from './heuristics';
import { classify, K } from './classifier';
import type { BiometricPayload, Verdict } from './types';

const logger = new Logger();
const metrics = new Metrics();

const COLLECTION_NAME = 'bio-handwriting';

// Module-scope singletons (reused across warm invocations)
let qdrantClient: QdrantClient | null = null;
let collectionReady = false;

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
    p.digits.length > 0 &&
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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    return cors({ statusCode: 204, body: '' });
  }

  // GET /health
  if (method === 'GET' && path === '/health') {
    return jsonResponse(200, { status: 'ok', timestamp: Date.now() });
  }

  // POST /v1/classify
  if (method === 'POST' && path === '/v1/classify') {
    return handleClassify(event);
  }

  // POST /admin/flush — delete and recreate the collection
  if (method === 'POST' && path === '/admin/flush') {
    return handleFlush();
  }

  // GET /admin/stats — collection point count
  if (method === 'GET' && path === '/admin/stats') {
    return handleStats();
  }

  return jsonResponse(404, { error: 'Not found' });
}

async function handleClassify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const start = Date.now();

  try {
    // Parse body (handle API Gateway base64 encoding)
    let bodyStr = event.body ?? '';
    if (event.isBase64Encoded) {
      bodyStr = Buffer.from(bodyStr, 'base64').toString('utf-8');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyStr);
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON' });
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

    // Upsert new point with metadata
    const pointId = crypto.randomUUID();
    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: pointId,
          vector: embedding,
          payload: {
            label: result.verdict === 'uncertain' ? hLabel : result.verdict,
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

    const verdict: Verdict = {
      verdict: result.verdict,
      confidence: Math.round(result.confidence * 1000) / 1000,
      neighborCount: result.neighborCount,
      heuristicLabel: hLabel,
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
      latencyMs: Date.now() - start,
    });

    return jsonResponse(200, verdict);
  } catch (error) {
    logger.error('Classification failed', { error });
    metrics.addMetric('ClassifyError', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    return jsonResponse(500, { error: 'Internal server error' });
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
    logger.info('Collection flushed', { collection: COLLECTION_NAME });
    return jsonResponse(200, { status: 'flushed', collection: COLLECTION_NAME });
  } catch (error) {
    logger.error('Flush failed', { error });
    return jsonResponse(500, { error: 'Flush failed' });
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
    return jsonResponse(200, { collection: COLLECTION_NAME, ...info });
  } catch (error) {
    logger.error('Stats failed', { error });
    return jsonResponse(500, { error: 'Stats failed' });
  }
}
