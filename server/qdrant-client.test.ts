import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { QdrantClient } from './qdrant-client';

// Mock the official Qdrant client
const mockSearch = vi.fn();
const mockUpsert = vi.fn();
const mockCollectionExists = vi.fn();
const mockCreateCollection = vi.fn();
const mockDeleteCollection = vi.fn();
const mockGetCollection = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  return {
    QdrantClient: class {
      search = mockSearch;
      upsert = mockUpsert;
      collectionExists = mockCollectionExists;
      createCollection = mockCreateCollection;
      deleteCollection = mockDeleteCollection;
      getCollection = mockGetCollection;
    },
  };
});

const smMock = mockClient(SecretsManagerClient);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

const COLLECTION = 'bio-handwriting';

function createClient(): QdrantClient {
  return new QdrantClient({
    baseUrl: 'https://qdrant.example.com',
    secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:test',
    logger: mockLogger,
  });
}

beforeEach(() => {
  smMock.reset();
  mockSearch.mockReset();
  mockUpsert.mockReset();
  mockCollectionExists.mockReset();
  mockCreateCollection.mockReset();
  mockDeleteCollection.mockReset();
  mockGetCollection.mockReset();

  smMock.on(GetSecretValueCommand).resolves({ SecretString: 'test-api-key' });
});

describe('QdrantClient', () => {
  describe('search', () => {
    it('fetches API key and delegates to underlying client', async () => {
      const fakeResults = [{ id: '1', score: 0.95, payload: { label: 'human' } }];
      mockSearch.mockResolvedValue(fakeResults);

      const client = createClient();
      const results = await client.search(COLLECTION, {
        vector: [0.1, 0.2],
        limit: 10,
        with_payload: true,
        score_threshold: 0.5,
      });

      expect(results).toEqual(fakeResults);
      expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });
  });

  describe('upsert', () => {
    it('delegates upsert to underlying client', async () => {
      mockUpsert.mockImplementation(async () => {});

      const client = createClient();
      await client.upsert(COLLECTION, {
        points: [{ id: 'p1', vector: [0.1, 0.2], payload: { label: 'human' } }],
      });

      expect(mockUpsert).toHaveBeenCalledWith(COLLECTION, {
        points: [{ id: 'p1', vector: [0.1, 0.2], payload: { label: 'human' } }],
      });
    });
  });

  describe('collectionExists', () => {
    it('returns true when collection exists', async () => {
      mockCollectionExists.mockResolvedValue({ exists: true });
      const client = createClient();
      expect(await client.collectionExists(COLLECTION)).toBe(true);
    });

    it('returns false when collection does not exist', async () => {
      mockCollectionExists.mockResolvedValue({ exists: false });
      const client = createClient();
      expect(await client.collectionExists(COLLECTION)).toBe(false);
    });
  });

  describe('createCollection', () => {
    it('delegates to underlying client with options', async () => {
      mockCreateCollection.mockImplementation(async () => {});
      const client = createClient();
      await client.createCollection(COLLECTION, {
        vectors: { size: 64, distance: 'Cosine' },
      });
      expect(mockCreateCollection).toHaveBeenCalledWith(COLLECTION, {
        vectors: { size: 64, distance: 'Cosine' },
      });
    });
  });

  describe('deleteCollection', () => {
    it('delegates to underlying client', async () => {
      mockDeleteCollection.mockImplementation(async () => {});
      const client = createClient();
      await client.deleteCollection(COLLECTION);
      expect(mockDeleteCollection).toHaveBeenCalledWith(COLLECTION);
    });
  });

  describe('collectionInfo', () => {
    it('returns points_count and status', async () => {
      mockGetCollection.mockResolvedValue({ points_count: 42, status: 'green' });
      const client = createClient();
      const info = await client.collectionInfo(COLLECTION);
      expect(info).toEqual({ points_count: 42, status: 'green' });
    });

    it('defaults points_count to 0 when undefined', async () => {
      mockGetCollection.mockResolvedValue({ status: 'green' });
      const client = createClient();
      const info = await client.collectionInfo(COLLECTION);
      expect(info.points_count).toBe(0);
    });
  });

  describe('API key caching', () => {
    it('reuses the cached API key for subsequent calls', async () => {
      mockSearch.mockResolvedValue([]);
      const client = createClient();

      await client.search('c', { vector: [1], limit: 1 });
      await client.search('c', { vector: [1], limit: 1 });
      await client.search('c', { vector: [1], limit: 1 });

      // Only one Secrets Manager call despite three operations
      expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('throws when secret is empty', async () => {
      smMock.reset();
      smMock.on(GetSecretValueCommand).resolves({ SecretString: undefined });

      const client = createClient();
      await expect(client.search('c', { vector: [1], limit: 1 })).rejects.toThrow(
        'Qdrant API key secret is empty'
      );
    });
  });
});
