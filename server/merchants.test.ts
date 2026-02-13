import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { hashApiKey, lookupMerchantBySecret, validateReturnUrl } from './merchants';
import type { Merchant } from './types';

const ddbMock = mockClient(DynamoDBDocumentClient);

const fakeMerchant: Merchant = {
  merchantId: 'merch-001',
  name: 'Test Co',
  apiKeyHash: createHash('sha256').update('ak_live_abc123').digest('hex'),
  apiKeyPrefix: 'ak_live_',
  allowedReturnUrls: ['https://example.com/callback', 'https://example.com/auth/done'],
  active: true,
  createdAt: 1700000000,
};

beforeEach(() => {
  ddbMock.reset();
  vi.stubEnv('MERCHANTS_TABLE', 'test-merchants');
});

// ── hashApiKey ──────────────────────────────────────────────────────

describe('hashApiKey', () => {
  it('produces a deterministic SHA-256 hex digest', () => {
    const hash = hashApiKey('ak_live_abc123');
    const expected = createHash('sha256').update('ak_live_abc123').digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toHaveLength(64);
  });

  it('produces different hashes for different keys', () => {
    expect(hashApiKey('ak_live_key1')).not.toBe(hashApiKey('ak_live_key2'));
  });
});

// ── lookupMerchantBySecret ──────────────────────────────────────────

describe('lookupMerchantBySecret', () => {
  it('returns the merchant when key matches and merchant is active', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [fakeMerchant] });

    const result = await lookupMerchantBySecret('ak_live_abc123');
    expect(result).toEqual(fakeMerchant);

    // Verify the query used the hash, not the raw key
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('apiKeyHash-index');
    expect(call.args[0].input.ExpressionAttributeValues![':h']).toBe(hashApiKey('ak_live_abc123'));
  });

  it('returns null when no merchant found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    expect(await lookupMerchantBySecret('ak_live_bogus')).toBeNull();
  });

  it('returns null when Items is undefined', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await lookupMerchantBySecret('ak_live_bogus')).toBeNull();
  });

  it('returns null when merchant is inactive', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...fakeMerchant, active: false }],
    });
    expect(await lookupMerchantBySecret('ak_live_abc123')).toBeNull();
  });
});

// ── validateReturnUrl ───────────────────────────────────────────────

describe('validateReturnUrl', () => {
  it('accepts an exact match from the allowlist', () => {
    expect(validateReturnUrl(fakeMerchant, 'https://example.com/callback')).toBe(true);
  });

  it('accepts a sub-path under an allowed prefix', () => {
    expect(validateReturnUrl(fakeMerchant, 'https://example.com/callback/step2')).toBe(true);
  });

  it('rejects HTTP (non-HTTPS)', () => {
    expect(validateReturnUrl(fakeMerchant, 'http://example.com/callback')).toBe(false);
  });

  it('rejects a different origin', () => {
    expect(validateReturnUrl(fakeMerchant, 'https://evil.com/callback')).toBe(false);
  });

  it('rejects a path that does not match any allowed prefix', () => {
    expect(validateReturnUrl(fakeMerchant, 'https://example.com/other')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateReturnUrl(fakeMerchant, 'not-a-url')).toBe(false);
  });

  it('ignores query params and fragments when matching', () => {
    expect(validateReturnUrl(fakeMerchant, 'https://example.com/callback?foo=bar#baz')).toBe(true);
  });

  it('rejects when the path tricks origin matching', () => {
    // https://example.com.evil.com/callback should not match https://example.com/callback
    expect(validateReturnUrl(fakeMerchant, 'https://example.com.evil.com/callback')).toBe(false);
  });
});
