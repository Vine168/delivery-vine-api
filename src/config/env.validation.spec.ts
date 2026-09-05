import { describe, expect, it } from 'vitest';
import { NodeEnv, validateEnv } from './env.validation.js';

/** A configuration that is complete and safe, to vary one field at a time. */
const SAFE = {
  NODE_ENV: NodeEnv.Production,
  DATABASE_URL: 'postgresql://user:pass@db:5432/deliver',
  REDIS_URL: 'redis://cache:6379',
  JWT_ACCESS_SECRET: 'K7fQ2mZx9Lp4Rv8Tn3Wq6Yb1Cd5Ge0Hj',
  JWT_REFRESH_SECRET: 'A3sD8fG1hJ4kL7mN0pQ5rT9vX2zB6cE1',
  ENCRYPTION_KEY: 'M4nB7vC2xZ9lK6jH3gF8dS5aQ1wE0rT7',
  CORS_ORIGINS: 'https://app.roktenh.com',
  OTP_EXPOSE_IN_RESPONSE: false,
  STORAGE_ACCESS_KEY: 'access',
  STORAGE_SECRET_KEY: 'secret',
  STORAGE_BUCKET: 'deliver',
  STORAGE_ENDPOINT: 'storage',
  MAP_BASE_URL: 'https://dev-map-api.roktenh.com',
  MAP_API_KEY: 'map-key',
};

const validate = (overrides: Record<string, unknown> = {}) => () => validateEnv({ ...SAFE, ...overrides });

describe('validateEnv', () => {
  it('accepts a complete production configuration', () => {
    expect(validate()).not.toThrow();
  });

  describe('in production', () => {
    it('refuses to hand out OTP codes in the response', () => {
      // The bypass this check exists for: anyone who can call register with
      // someone else's number would receive their code.
      expect(validate({ OTP_EXPOSE_IN_RESPONSE: true })).toThrow(/OTP_EXPOSE_IN_RESPONSE/);
    });

    it('refuses a wildcard CORS origin, because the API sends credentials', () => {
      expect(validate({ CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
      expect(validate({ CORS_ORIGINS: ' * ' })).toThrow(/CORS_ORIGINS/);
    });

    it('refuses secrets that were never replaced', () => {
      expect(validate({ JWT_ACCESS_SECRET: 'change-me-change-me-change-me-abc' })).toThrow(/placeholder/);
      expect(validate({ ENCRYPTION_KEY: 'your-secret-key-your-secret-key-1' })).toThrow(/placeholder/);
    });

    it('refuses one secret used for both token types', () => {
      // Sharing them means a stolen access token can be replayed as a refresh
      // token, which outlives it by a month.
      expect(validate({ JWT_REFRESH_SECRET: SAFE.JWT_ACCESS_SECRET })).toThrow(/must differ/);
    });

    it('reports every problem at once rather than one per restart', () => {
      const error = validate({ OTP_EXPOSE_IN_RESPONSE: true, CORS_ORIGINS: '*' });

      expect(error).toThrow(/OTP_EXPOSE_IN_RESPONSE/);
      expect(error).toThrow(/CORS_ORIGINS/);
    });
  });

  describe('outside production', () => {
    it('leaves development alone, where all of this is convenient', () => {
      expect(
        validate({ NODE_ENV: NodeEnv.Development, OTP_EXPOSE_IN_RESPONSE: true, CORS_ORIGINS: '*' }),
      ).not.toThrow();
    });

    it('leaves the test environment alone', () => {
      expect(
        validate({ NODE_ENV: NodeEnv.Test, OTP_EXPOSE_IN_RESPONSE: true, CORS_ORIGINS: '*' }),
      ).not.toThrow();
    });
  });

  describe('field validation still applies', () => {
    it('rejects a short signing secret', () => {
      expect(validate({ JWT_ACCESS_SECRET: 'too-short' })).toThrow(/at least 32 characters/);
    });
  });
});
