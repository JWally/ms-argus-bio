// server/merchants.ts
// API key hashing, merchant lookup, and return URL validation

import { createHash } from 'crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, tableName } from './dynamo-client';
import type { Merchant } from './types';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function lookupMerchantBySecret(secret: string): Promise<Merchant | null> {
  const hash = hashApiKey(secret);
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: tableName('MERCHANTS_TABLE'),
      IndexName: 'apiKeyHash-index',
      KeyConditionExpression: 'apiKeyHash = :h',
      ExpressionAttributeValues: { ':h': hash },
      Limit: 1,
    })
  );

  const item = result.Items?.[0] as Merchant | undefined;
  if (!item || !item.active) return null;
  return item;
}

export function validateReturnUrl(merchant: Merchant, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const candidate = `${parsed.origin}${parsed.pathname}`;
  return merchant.allowedReturnUrls.some((allowed) => candidate.startsWith(allowed));
}
