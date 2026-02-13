// server/qdrant-client.ts
// Thin wrapper around @qdrant/js-client-rest with AWS Secrets Manager auth
// Adapted from ms-argus-api/src/services/vector/qdrant-client.ts

import { QdrantClient as OfficialClient } from '@qdrant/js-client-rest';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Logger } from '@aws-lambda-powertools/logger';

export interface QdrantClientConfig {
  baseUrl: string;
  secretArn: string;
  logger: Logger;
  timeoutMs?: number;
  secretsClient?: SecretsManagerClient;
}

export interface VectorSearchRequest {
  vector: number[];
  limit: number;
  with_payload?: boolean;
  with_vector?: boolean;
  score_threshold?: number;
}

export interface VectorSearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
  vector?: number[];
}

export interface VectorUpsertRequest {
  points: VectorPoint[];
}

export interface VectorPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export class QdrantClient {
  private readonly secretsClient: SecretsManagerClient;
  private readonly config: QdrantClientConfig;
  private client: OfficialClient | null = null;
  private cachedApiKey: string | null = null;
  private apiKeyExpiresAt = 0;
  private static readonly API_KEY_CACHE_TTL_MS = 15 * 60 * 1000;

  constructor(config: QdrantClientConfig) {
    this.config = config;
    this.secretsClient = config.secretsClient ?? new SecretsManagerClient({});
  }

  async search(collection: string, request: VectorSearchRequest): Promise<VectorSearchResult[]> {
    const client = await this.getClient();
    const results = await client.search(collection, {
      vector: request.vector,
      limit: request.limit,
      with_payload: request.with_payload,
      with_vector: request.with_vector,
      score_threshold: request.score_threshold,
    });
    return results as VectorSearchResult[];
  }

  async upsert(collection: string, request: VectorUpsertRequest): Promise<void> {
    const client = await this.getClient();
    await client.upsert(collection, { points: request.points });
  }

  async setPayload(
    collection: string,
    payload: Record<string, unknown>,
    pointIds: (string | number)[]
  ): Promise<void> {
    const client = await this.getClient();
    await client.setPayload(collection, { payload, points: pointIds });
  }

  async collectionExists(collection: string): Promise<boolean> {
    const client = await this.getClient();
    const result = await client.collectionExists(collection);
    return result.exists;
  }

  async createCollection(
    collection: string,
    options: {
      vectors: { size: number; distance: 'Cosine' | 'Euclid' | 'Dot' };
    }
  ): Promise<void> {
    const client = await this.getClient();
    await client.createCollection(collection, options);
  }

  async deleteCollection(collection: string): Promise<void> {
    const client = await this.getClient();
    await client.deleteCollection(collection);
  }

  async scroll(
    collection: string,
    options: {
      limit?: number;
      offset?: string | number | null;
      with_payload?: boolean;
      with_vector?: boolean;
    }
  ): Promise<{
    points: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>;
    next_page_offset: string | number | null;
  }> {
    const client = await this.getClient();
    const result = await client.scroll(collection, {
      limit: options.limit ?? 100,
      offset: options.offset ?? undefined,
      with_payload: options.with_payload ?? true,
      with_vector: options.with_vector ?? false,
    });
    return result as {
      points: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>;
      next_page_offset: string | number | null;
    };
  }

  async collectionInfo(collection: string): Promise<{ points_count: number; status: string }> {
    const client = await this.getClient();
    const info = await client.getCollection(collection);
    return {
      points_count: info.points_count ?? 0,
      status: info.status,
    };
  }

  private async getClient(): Promise<OfficialClient> {
    const apiKey = await this.getApiKey();
    if (!this.client) {
      this.client = new OfficialClient({
        url: this.config.baseUrl,
        apiKey,
        timeout: this.config.timeoutMs ?? 10000,
      });
    }
    return this.client;
  }

  private async getApiKey(): Promise<string> {
    const now = Date.now();
    if (this.cachedApiKey && now < this.apiKeyExpiresAt) {
      return this.cachedApiKey;
    }

    const response = await this.secretsClient.send(
      new GetSecretValueCommand({ SecretId: this.config.secretArn })
    );
    if (!response.SecretString) {
      throw new Error('Qdrant API key secret is empty');
    }

    this.cachedApiKey = response.SecretString;
    this.apiKeyExpiresAt = now + QdrantClient.API_KEY_CACHE_TTL_MS;
    this.client = null;
    return this.cachedApiKey;
  }
}
