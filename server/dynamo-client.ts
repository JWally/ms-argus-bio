// server/dynamo-client.ts
// DynamoDB DocumentClient singleton (matches Qdrant singleton pattern in handler.ts)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let docClient: DynamoDBDocumentClient | null = null;

export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

export function tableName(envKey: string): string {
  const name = process.env[envKey];
  if (!name) {
    throw new Error(`Missing required env var: ${envKey}`);
  }
  return name;
}
