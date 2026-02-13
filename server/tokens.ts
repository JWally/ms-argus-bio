// server/tokens.ts
// Token create + atomic single-use redemption

import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { getDocClient, tableName } from './dynamo-client';
import type { Label, Token } from './types';

const TOKEN_TTL_SECONDS = 300; // 5 minutes

export async function createToken(
  sessionId: string,
  merchantId: string,
  verdict: Label,
  confidence: number
): Promise<Token> {
  const now = Math.floor(Date.now() / 1000);
  const token: Token = {
    token: crypto.randomUUID(),
    sessionId,
    merchantId,
    verdict,
    confidence,
    redeemed: false,
    createdAt: now,
    ttl: now + TOKEN_TTL_SECONDS,
  };

  await getDocClient().send(
    new PutCommand({
      TableName: tableName('TOKENS_TABLE'),
      Item: token,
    })
  );

  return token;
}

export async function redeemToken(tokenValue: string, merchantId: string): Promise<Token | null> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName('TOKENS_TABLE'),
      Key: { token: tokenValue },
    })
  );

  const item = result.Item as Token | undefined;
  if (!item) return null;
  if (item.merchantId !== merchantId) return null;
  if (item.redeemed) return null;

  // Manual TTL check (DynamoDB TTL deletion is eventually consistent)
  const now = Math.floor(Date.now() / 1000);
  if (now >= item.ttl) return null;

  // Atomic conditional update: redeemed false → true
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName('TOKENS_TABLE'),
        Key: { token: tokenValue },
        UpdateExpression: 'SET redeemed = :true',
        ConditionExpression: 'redeemed = :false',
        ExpressionAttributeValues: {
          ':true': true,
          ':false': false,
        },
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }

  return item;
}
