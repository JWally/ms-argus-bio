import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createSession, getSession, completeSession } from './sessions';
import type { Session } from './types';

const MERCHANT_ID = 'merch-001';
const RETURN_URL = 'https://example.com/cb';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.stubEnv('SESSIONS_TABLE', 'test-sessions');
});

// ── createSession ───────────────────────────────────────────────────

describe('createSession', () => {
  it('writes a pending session with a UUID and 1hr TTL', async () => {
    ddbMock.on(PutCommand).resolves({});

    const before = Math.floor(Date.now() / 1000);
    const session = await createSession(MERCHANT_ID, RETURN_URL);
    const after = Math.floor(Date.now() / 1000);

    // Verify returned shape
    expect(session.sessionId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    expect(session.merchantId).toBe(MERCHANT_ID);
    expect(session.returnUrl).toBe(RETURN_URL);
    expect(session.status).toBe('pending');
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.ttl).toBe(session.createdAt + 3600);

    // Verify the PutCommand was sent with the right item
    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.TableName).toBe('test-sessions');
    expect(call.args[0].input.Item).toEqual(session);
  });

  it('generates unique session IDs', async () => {
    ddbMock.on(PutCommand).resolves({});

    const s1 = await createSession(MERCHANT_ID, 'https://a.com');
    const s2 = await createSession(MERCHANT_ID, 'https://a.com');
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });
});

// ── getSession ──────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns the session when it exists', async () => {
    const stored: Session = {
      sessionId: 'sess-aaa',
      merchantId: MERCHANT_ID,
      returnUrl: RETURN_URL,
      challenge: [],
      status: 'pending',
      createdAt: 1700000000,
      ttl: 1700003600,
    };
    ddbMock.on(GetCommand).resolves({ Item: stored });

    const result = await getSession('sess-aaa');
    expect(result).toEqual(stored);
  });

  it('returns null when session does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    expect(await getSession('sess-missing')).toBeNull();
  });
});

// ── completeSession ─────────────────────────────────────────────────

describe('completeSession', () => {
  it('sends a conditional update from pending to completed', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await completeSession('sess-aaa');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.Key).toEqual({ sessionId: 'sess-aaa' });
    expect(call.args[0].input.ConditionExpression).toBe('#s = :pending');
    expect(call.args[0].input.ExpressionAttributeValues![':completed']).toBe('completed');
    expect(call.args[0].input.ExpressionAttributeValues![':pending']).toBe('pending');
  });

  it('throws when session is not in pending state', async () => {
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'Condition not met',
        $metadata: {},
      })
    );

    await expect(completeSession('sess-already-done')).rejects.toThrow(
      ConditionalCheckFailedException
    );
  });
});
