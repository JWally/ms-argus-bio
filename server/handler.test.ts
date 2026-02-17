import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda'; // eslint-disable-line import-x/order

// ── Mock all dependencies ───────────────────────────────────────────

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

vi.mock('@aws-lambda-powertools/metrics', () => ({
  Metrics: class {
    addMetric = vi.fn();
    publishStoredMetrics = vi.fn();
  },
  MetricUnit: { Milliseconds: 'Milliseconds', Count: 'Count' },
}));

const mockSearch = vi.fn();
const mockUpsert = vi.fn();
const mockCollectionExists = vi.fn();
const mockCreateCollection = vi.fn();
const mockDeleteCollection = vi.fn();
const mockCollectionInfo = vi.fn();

vi.mock('./qdrant-client', () => ({
  QdrantClient: class {
    search = mockSearch;
    upsert = mockUpsert;
    collectionExists = mockCollectionExists;
    createCollection = mockCreateCollection;
    deleteCollection = mockDeleteCollection;
    collectionInfo = mockCollectionInfo;
  },
}));

const mockEncode = vi.fn().mockReturnValue(new Array(66).fill(0.5));
vi.mock('./embedding', () => ({
  encode: (...args: unknown[]) => mockEncode(...args),
  EMBEDDING_VERSION: 'v3',
  EMBEDDING_DIMS: 66,
}));

const mockHeuristicLabel = vi.fn().mockReturnValue('human');
const mockTimingCV = vi.fn().mockReturnValue(1.0);
vi.mock('./heuristics', () => ({
  heuristicLabel: (...args: unknown[]) => mockHeuristicLabel(...args),
  timingCV: (...args: unknown[]) => mockTimingCV(...args),
}));

const mockClassify = vi.fn().mockReturnValue({
  verdict: 'human',
  confidence: 0.9,
  neighborCount: 5,
});
vi.mock('./classifier', () => ({
  classify: (...args: unknown[]) => mockClassify(...args),
  K: 10,
}));

const mockLookupMerchant = vi.fn();
const mockValidateReturnUrl = vi.fn();
vi.mock('./merchants', () => ({
  lookupMerchantBySecret: (...args: unknown[]) => mockLookupMerchant(...args),
  validateReturnUrl: (...args: unknown[]) => mockValidateReturnUrl(...args),
}));

const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockCompleteSession = vi.fn();
vi.mock('./sessions', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  completeSession: (...args: unknown[]) => mockCompleteSession(...args),
}));

const mockCreateToken = vi.fn();
const mockRedeemToken = vi.fn();
vi.mock('./tokens', () => ({
  createToken: (...args: unknown[]) => mockCreateToken(...args),
  redeemToken: (...args: unknown[]) => mockRedeemToken(...args),
}));

// ── Import handler after all mocks are set up ───────────────────────

import { handler } from './handler';

// ── Constants ───────────────────────────────────────────────────────

const POST = 'POST';
const ROUTE_CLASSIFY = '/v1/classify';
const ROUTE_SESSION = '/v1/session';
const ROUTE_VERIFY = '/v1/verify';
const ROUTE_FLUSH = '/admin/flush';
const ROUTE_STATS = '/admin/stats';
const TEST_SECRET = 'ak_live_x';

const MERCHANT_ID = 'merch-001';
const RETURN_URL = 'https://example.com/cb';
const INVALID_JSON_MSG = 'returns 400 for invalid JSON';
const QDRANT_ERROR = new Error('Qdrant down');
const DDB_ERROR = new Error('DDB timeout');

const MERCHANT = {
  merchantId: MERCHANT_ID,
  name: 'Test Co',
  active: true,
  allowedReturnUrls: [RETURN_URL],
};

const VALID_PAYLOAD = {
  challengeId: 'test-123',
  challenge: [1, 2, 3],
  timestamp: Date.now(),
  completionTimeMs: 3000,
  passed: true,
  digits: [
    {
      target: 1,
      recognized: 1,
      confidence: 0.99,
      timeMs: 1000,
      strokes: [],
      imageData: [],
    },
  ],
  confidenceTimeline: [],
  inputType: 'mouse',
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 2,
  userAgent: 'test-agent',
  features: {
    strokeCount: 5,
    totalPoints: 100,
    avgSpeed: 0.5,
    speedVariance: 0.1,
    maxSpeed: 1.0,
    avgPressure: 0.5,
    pressureVariance: 0.05,
    avgContactWidth: 10,
    avgContactHeight: 10,
    totalDurationMs: 3000,
    avgTimeBetweenStrokes: 200,
    eventFrequencyHz: 60,
    avgJerk: 0.01,
  },
};

// ── Test helpers ────────────────────────────────────────────────────

function makeEvent(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method } } as never,
    rawPath: path,
    body: body ? JSON.stringify(body) : '',
    isBase64Encoded: false,
    headers: {},
  } as APIGatewayProxyEventV2;
}

function parseBody(result: { body?: string }): unknown {
  return JSON.parse(result.body ?? '');
}

const resolvedVoid = vi.fn<() => Promise<void>>().mockResolvedValue();

beforeEach(() => {
  vi.stubEnv('QDRANT_URL', 'https://qdrant.test');
  vi.stubEnv('QDRANT_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123:secret:test');
  vi.stubEnv('MERCHANTS_TABLE', 'test-merchants');
  vi.stubEnv('SESSIONS_TABLE', 'test-sessions');
  vi.stubEnv('TOKENS_TABLE', 'test-tokens');
  vi.stubEnv('SITE_DOMAIN', 'bio.argus.pw');

  mockSearch.mockResolvedValue([]);
  mockUpsert.mockImplementation(resolvedVoid);
  mockCollectionExists.mockResolvedValue(true);
  mockCollectionInfo.mockResolvedValue({ points_count: 999, status: 'green' });
  mockLookupMerchant.mockResolvedValue(null);
  mockValidateReturnUrl.mockReturnValue(true);
  mockCreateSession.mockResolvedValue({
    sessionId: 'sess-new',
    merchantId: MERCHANT_ID,
    returnUrl: RETURN_URL,
    status: 'pending',
  });
  mockGetSession.mockResolvedValue(null);
  mockCompleteSession.mockImplementation(resolvedVoid);
  mockCreateToken.mockResolvedValue({
    token: 'tok-new',
    sessionId: 'sess-aaa',
    merchantId: MERCHANT_ID,
    verdict: 'human',
    confidence: 0.9,
  });
  mockRedeemToken.mockResolvedValue(null);
});

// ── Tests ───────────────────────────────────────────────────────────

describe('handler routing', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    const result = (await handler(makeEvent('OPTIONS', '/'))) as {
      statusCode: number;
      headers: Record<string, string>;
    };
    expect(result.statusCode).toBe(204);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('GET /health returns 200 with status ok', async () => {
    const result = (await handler(makeEvent('GET', '/health'))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toMatchObject({ status: 'ok' });
  });

  it('unknown route returns 404', async () => {
    const result = (await handler(makeEvent('GET', '/nonexistent'))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });
});

describe('POST /v1/classify', () => {
  it(INVALID_JSON_MSG, async () => {
    const event = makeEvent(POST, ROUTE_CLASSIFY);
    event.body = 'not-json';
    const result = (await handler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid payload structure', async () => {
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, { bad: true }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns verdict for valid payload (demo mode, no sessionId)', async () => {
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, VALID_PAYLOAD))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.verdict).toBe('human');
    expect(body.confidence).toBeDefined();
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('returnUrl');
  });

  it('returns token + returnUrl when sessionId is provided', async () => {
    mockGetSession.mockResolvedValue({
      sessionId: 'sess-aaa',
      merchantId: MERCHANT_ID,
      returnUrl: RETURN_URL,
      status: 'pending',
    });

    const payload = { ...VALID_PAYLOAD, sessionId: 'sess-aaa' };
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, payload))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.token).toBe('tok-new');
    expect(body.returnUrl).toBe(RETURN_URL);
    expect(mockCompleteSession).toHaveBeenCalledWith('sess-aaa');
  });

  it('returns 404 when sessionId references nonexistent session', async () => {
    mockGetSession.mockResolvedValue(null);
    const payload = { ...VALID_PAYLOAD, sessionId: 'sess-missing' };
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, payload))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });

  it('returns 409 when session is already completed', async () => {
    mockGetSession.mockResolvedValue({
      sessionId: 'sess-done',
      merchantId: MERCHANT_ID,
      returnUrl: RETURN_URL,
      status: 'completed',
    });
    const payload = { ...VALID_PAYLOAD, sessionId: 'sess-done' };
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, payload))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(409);
  });

  it('handles base64-encoded body', async () => {
    const event = makeEvent(POST, ROUTE_CLASSIFY);
    event.body = Buffer.from(JSON.stringify(VALID_PAYLOAD)).toString('base64');
    event.isBase64Encoded = true;
    const result = (await handler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(200);
  });
});

describe('POST /v1/session', () => {
  it('returns 400 for missing fields', async () => {
    const result = (await handler(makeEvent(POST, ROUTE_SESSION, { secret: TEST_SECRET }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 401 for invalid API key', async () => {
    mockLookupMerchant.mockResolvedValue(null);
    const result = (await handler(
      makeEvent(POST, ROUTE_SESSION, {
        secret: 'ak_live_bad',
        returnUrl: RETURN_URL,
      })
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns 403 when returnUrl is not allowed', async () => {
    mockLookupMerchant.mockResolvedValue(MERCHANT);
    mockValidateReturnUrl.mockReturnValue(false);
    const result = (await handler(
      makeEvent(POST, ROUTE_SESSION, {
        secret: 'ak_live_good',
        returnUrl: 'https://evil.com/hack',
      })
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('creates session and returns captchaUrl on success', async () => {
    mockLookupMerchant.mockResolvedValue(MERCHANT);
    mockValidateReturnUrl.mockReturnValue(true);
    const result = (await handler(
      makeEvent(POST, ROUTE_SESSION, {
        secret: 'ak_live_good',
        returnUrl: RETURN_URL,
      })
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, string>;
    expect(body.sessionId).toBe('sess-new');
    expect(body.captchaUrl).toContain('bio.argus.pw');
    expect(body.captchaUrl).toContain('sid=sess-new');
  });

  it(INVALID_JSON_MSG, async () => {
    const event = makeEvent(POST, ROUTE_SESSION);
    event.body = '{broken';
    const result = (await handler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });
});

describe('POST /v1/verify', () => {
  it('returns 400 for missing fields', async () => {
    const result = (await handler(makeEvent(POST, ROUTE_VERIFY, { secret: TEST_SECRET }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 401 for invalid API key', async () => {
    mockLookupMerchant.mockResolvedValue(null);
    const result = (await handler(
      makeEvent(POST, ROUTE_VERIFY, {
        secret: 'ak_live_bad',
        response: 'tok-123',
      })
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('returns success: false when token is invalid', async () => {
    mockLookupMerchant.mockResolvedValue(MERCHANT);
    mockRedeemToken.mockResolvedValue(null);
    const result = (await handler(
      makeEvent(POST, ROUTE_VERIFY, {
        secret: 'ak_live_good',
        response: 'tok-bad',
      })
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toEqual({ success: false });
  });

  it('returns success: true with verdict on valid token', async () => {
    mockLookupMerchant.mockResolvedValue(MERCHANT);
    mockRedeemToken.mockResolvedValue({
      token: 'tok-123',
      sessionId: 'sess-aaa',
      merchantId: MERCHANT_ID,
      verdict: 'human',
      confidence: 0.92,
      createdAt: 1700000000,
    });
    const result = (await handler(
      makeEvent(POST, ROUTE_VERIFY, {
        secret: 'ak_live_good',
        response: 'tok-123',
      })
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.verdict).toBe('human');
    expect(body.confidence).toBe(0.92);
    expect(body.sessionId).toBe('sess-aaa');
    expect(body.timestamp).toBe(1700000000);
  });

  it(INVALID_JSON_MSG, async () => {
    const event = makeEvent(POST, ROUTE_VERIFY);
    event.body = 'nope';
    const result = (await handler(event)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });
});

describe('POST /admin/flush', () => {
  it('deletes and recreates collection when it exists', async () => {
    mockCollectionExists.mockResolvedValue(true);
    mockDeleteCollection.mockImplementation(resolvedVoid);
    mockCreateCollection.mockImplementation(resolvedVoid);
    const result = (await handler(makeEvent(POST, ROUTE_FLUSH))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toMatchObject({ status: 'flushed' });
    expect(mockDeleteCollection).toHaveBeenCalled();
    expect(mockCreateCollection).toHaveBeenCalled();
  });

  it('creates collection even when it does not exist', async () => {
    mockDeleteCollection.mockClear();
    mockCollectionExists.mockResolvedValue(false);
    mockCreateCollection.mockImplementation(resolvedVoid);
    const result = (await handler(makeEvent(POST, ROUTE_FLUSH))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
    expect(mockDeleteCollection).not.toHaveBeenCalled();
    expect(mockCreateCollection).toHaveBeenCalled();
  });
});

describe('GET /admin/stats', () => {
  it('returns collection info when it exists', async () => {
    mockCollectionExists.mockResolvedValue(true);
    mockCollectionInfo.mockResolvedValue({ points_count: 42, status: 'green' });
    const result = (await handler(makeEvent('GET', ROUTE_STATS))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.points_count).toBe(42);
    expect(body.trainingCap).toBe(1000);
  });

  it('returns points_count 0 when collection does not exist', async () => {
    mockCollectionExists.mockResolvedValue(false);
    const result = (await handler(makeEvent('GET', ROUTE_STATS))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toMatchObject({ points_count: 0, status: 'not_found' });
  });

  it('returns 500 when stats throws', async () => {
    mockCollectionExists.mockRejectedValue(QDRANT_ERROR);
    const result = (await handler(makeEvent('GET', ROUTE_STATS))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(500);
  });
});

describe('error handling', () => {
  it('POST /admin/flush returns 500 on error', async () => {
    mockCollectionExists.mockRejectedValue(QDRANT_ERROR);
    const result = (await handler(makeEvent(POST, ROUTE_FLUSH))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(500);
  });

  it('POST /v1/session returns 500 on unexpected error', async () => {
    mockLookupMerchant.mockRejectedValue(DDB_ERROR);
    const result = (await handler(
      makeEvent(POST, ROUTE_SESSION, {
        secret: TEST_SECRET,
        returnUrl: RETURN_URL,
      })
    )) as { statusCode: number };
    expect(result.statusCode).toBe(500);
  });

  it('POST /v1/verify returns 500 on unexpected error', async () => {
    mockLookupMerchant.mockRejectedValue(DDB_ERROR);
    const result = (await handler(
      makeEvent(POST, ROUTE_VERIFY, {
        secret: TEST_SECRET,
        response: 'tok-123',
      })
    )) as { statusCode: number };
    expect(result.statusCode).toBe(500);
  });

  it('POST /v1/classify returns 500 on unexpected error', async () => {
    mockEncode.mockImplementation(() => {
      throw new Error('encode boom');
    });
    const result = (await handler(makeEvent(POST, ROUTE_CLASSIFY, VALID_PAYLOAD))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(500);
    mockEncode.mockReturnValue(new Array(64).fill(0.5));
  });
});
