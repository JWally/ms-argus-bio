import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createToken, redeemToken } from './tokens';
import type { Token } from './types';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.stubEnv('TOKENS_TABLE', 'test-tokens');
});

// ── createToken ─────────────────────────────────────────────────────

describe('createToken', () => {
  it('writes a token with 5min TTL and the correct verdict', async () => {
    ddbMock.on(PutCommand).resolves({});

    const before = Math.floor(Date.now() / 1000);
    const token = await createToken('sess-aaa', 'merch-001', 'human', 0.95);
    const after = Math.floor(Date.now() / 1000);

    expect(token.token).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    expect(token.sessionId).toBe('sess-aaa');
    expect(token.merchantId).toBe('merch-001');
    expect(token.verdict).toBe('human');
    expect(token.confidence).toBe(0.95);
    expect(token.redeemed).toBe(false);
    expect(token.ttl).toBe(token.createdAt + 300);
    expect(token.createdAt).toBeGreaterThanOrEqual(before);
    expect(token.createdAt).toBeLessThanOrEqual(after);
  });
});

// ── redeemToken ─────────────────────────────────────────────────────

describe('redeemToken', () => {
  const validToken: Token = {
    token: 'tok-111',
    sessionId: 'sess-aaa',
    merchantId: 'merch-001',
    verdict: 'human',
    confidence: 0.92,
    redeemed: false,
    createdAt: Math.floor(Date.now() / 1000),
    ttl: Math.floor(Date.now() / 1000) + 300,
  };

  it('returns the token and marks it redeemed on first call', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...validToken } });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await redeemToken('tok-111', 'merch-001');

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('human');
    expect(result!.confidence).toBe(0.92);
    expect(result!.sessionId).toBe('sess-aaa');

    // Verify atomic conditional update
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall.args[0].input.ConditionExpression).toBe('redeemed = :false');
  });

  it('returns null when token does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    expect(await redeemToken('tok-missing', 'merch-001')).toBeNull();
  });

  it('returns null when merchantId does not match (isolation)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...validToken } });
    expect(await redeemToken('tok-111', 'merch-OTHER')).toBeNull();
  });

  it('returns null when token is already redeemed (pre-check)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...validToken, redeemed: true },
    });
    expect(await redeemToken('tok-111', 'merch-001')).toBeNull();
  });

  it('returns null on concurrent double-redemption (conditional check fails)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...validToken } });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'Condition not met',
        $metadata: {},
      })
    );

    expect(await redeemToken('tok-111', 'merch-001')).toBeNull();
  });

  it('returns null when token TTL has expired', async () => {
    const expiredToken: Token = {
      ...validToken,
      createdAt: 1700000000,
      ttl: 1700000001, // way in the past
    };
    ddbMock.on(GetCommand).resolves({ Item: expiredToken });

    expect(await redeemToken('tok-111', 'merch-001')).toBeNull();
  });

  it('rethrows non-ConditionalCheckFailed errors', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...validToken } });
    ddbMock.on(UpdateCommand).rejects(new Error('Network timeout'));

    await expect(redeemToken('tok-111', 'merch-001')).rejects.toThrow('Network timeout');
  });
});
