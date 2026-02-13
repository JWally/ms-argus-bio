import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tableName } from './dynamo-client';

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('tableName', () => {
  it('returns the value of the env var', () => {
    vi.stubEnv('SESSIONS_TABLE', 'my-sessions');
    expect(tableName('SESSIONS_TABLE')).toBe('my-sessions');
  });

  it('throws when the env var is missing', () => {
    delete process.env.SESSIONS_TABLE;
    expect(() => tableName('SESSIONS_TABLE')).toThrow('Missing required env var: SESSIONS_TABLE');
  });

  it('throws when the env var is empty string', () => {
    vi.stubEnv('SESSIONS_TABLE', '');
    expect(() => tableName('SESSIONS_TABLE')).toThrow('Missing required env var: SESSIONS_TABLE');
  });
});
