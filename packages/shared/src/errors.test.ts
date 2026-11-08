import { describe, expect, it } from 'vitest';
import { AtlasError, ConfigurationError, errorCodes, isAtlasError } from './index.js';

describe('AtlasError', () => {
  it('derives HTTP status and default message from the error code catalogue', () => {
    const error = new AtlasError('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.message).toBe(errorCodes.RATE_LIMITED.title);
    expect(error.detail).toBeUndefined();
    expect(isAtlasError(error)).toBe(true);
  });

  it('keeps the cause for internal diagnostics without exposing it as detail', () => {
    const cause = new Error('connection refused 10.0.0.1');
    const error = new AtlasError('DEPENDENCY_UNAVAILABLE', { cause });
    expect(error.cause).toBe(cause);
    expect(error.detail).toBeUndefined();
  });

  it('does not treat ordinary errors as AtlasErrors', () => {
    expect(isAtlasError(new Error('x'))).toBe(false);
  });

  it('maps every error code to a 4xx or 5xx status', () => {
    for (const { status } of Object.values(errorCodes)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('ConfigurationError', () => {
  it('summarises issues by key', () => {
    const error = new ConfigurationError([{ key: 'PORT', message: 'Expected number' }]);
    expect(error.message).toContain('PORT');
    expect(error.issues).toHaveLength(1);
  });
});
