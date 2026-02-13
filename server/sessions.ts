// server/sessions.ts
// Session create / get / complete

import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, tableName } from './dynamo-client';
import type { Session } from './types';

const SESSION_TTL_SECONDS = 3600; // 1 hour

export async function createSession(merchantId: string, returnUrl: string): Promise<Session> {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    sessionId: crypto.randomUUID(),
    merchantId,
    returnUrl,
    challenge: [],
    status: 'pending',
    createdAt: now,
    ttl: now + SESSION_TTL_SECONDS,
  };

  await getDocClient().send(
    new PutCommand({
      TableName: tableName('SESSIONS_TABLE'),
      Item: session,
    })
  );

  return session;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName('SESSIONS_TABLE'),
      Key: { sessionId },
    })
  );
  return (result.Item as Session) ?? null;
}

export async function completeSession(sessionId: string): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: tableName('SESSIONS_TABLE'),
      Key: { sessionId },
      UpdateExpression: 'SET #s = :completed',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':completed': 'completed',
        ':pending': 'pending',
      },
    })
  );
}
