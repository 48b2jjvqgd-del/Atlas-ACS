import { describe, expect, it } from 'vitest';
import { forwardablePath } from './upstream-path.js';

describe('forwardablePath (confused-deputy guard)', () => {
  it('forwards canonical API paths with their query', () => {
    expect(forwardablePath('/v1/tenants?limit=10&q=north')).toEqual({
      pathname: '/v1/tenants',
      search: '?limit=10&q=north',
    });
    expect(
      forwardablePath('/v1/tenants/1a2b0000-0000-4000-8000-000000000001/users/abc/roles'),
    ).toMatchObject({
      pathname: '/v1/tenants/1a2b0000-0000-4000-8000-000000000001/users/abc/roles',
    });
    expect(forwardablePath('/v1/audit/chains/platform/verify')).not.toBeNull();
  });

  it.each([
    '/v1/tenants/x/users/../../../internal/principals/5ab00000',
    '/v1/tenants/x/users/%2e%2e/%2e%2e/%2e%2e/internal/principals/5ab00000',
    '/v1/tenants/x/users/%2E%2E%2F%2E%2E%2Finternal/principals/x',
    '/v1/tenants/x/users/.%2e/internal',
    '/v1/tenants/x/./users',
    '/v1/tenants/x\\..\\..\\internal',
    '/v1/tenants//users',
    '/v1/internal/principals/5ab00000',
    '/v1/identity/internal/x',
    '/v1/tenants/x%2fusers',
    '/v1/tenants/%00',
    '//evil.example/v1/tenants',
    '/v2/tenants',
    'http://evil.example/v1/tenants',
  ])('refuses %s', (path) => {
    expect(forwardablePath(path)).toBeNull();
  });
});
