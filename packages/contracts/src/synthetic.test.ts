import { describe, expect, it } from 'vitest';
import { inviteUserBodySchema, issuerSettingsSchema } from './index.js';
import { isSyntheticEmail, STAGE_1A_SYNTHETIC_ONLY } from './synthetic.js';

describe('Stage 1A synthetic-data rule', () => {
  it('is fixed, not configurable', () => {
    expect(STAGE_1A_SYNTHETIC_ONLY).toBe(true);
  });

  it.each([
    'a@atlas.test',
    'admin@northstar.test',
    'x@sub.domain.test',
    'x@thing.example',
    'x@nowhere.invalid',
    'x@machine.localhost',
    'x@example.com',
    'x@mail.example.org',
    'x@example.net',
  ])('accepts reserved domain %s', (email) => {
    expect(isSyntheticEmail(email)).toBe(true);
  });

  it.each([
    'someone@gmail.com',
    'ops@bank.co.uk',
    'x@test.com',
    'x@example.co',
    'x@notexample.com',
    'x@atlas.test.evil.com',
    'x@example.com.evil',
  ])('refuses routable domain %s', (email) => {
    expect(isSyntheticEmail(email)).toBe(false);
  });

  it('applies to invitations and issuer contact details', () => {
    const invite = { displayName: 'Someone', roles: ['reporting-user'] };
    expect(
      inviteUserBodySchema.safeParse({ ...invite, email: 'Real.Person@Gmail.com' }).success,
    ).toBe(false);
    expect(inviteUserBodySchema.parse({ ...invite, email: 'New.User@Atlas.TEST' }).email).toBe(
      'new.user@atlas.test',
    );
    expect(
      issuerSettingsSchema.safeParse({ supportContactEmail: 'cards@realbank.com' }).success,
    ).toBe(false);
    expect(
      issuerSettingsSchema.parse({ supportContactEmail: 'Cards@Northstar.test' })
        .supportContactEmail,
    ).toBe('Cards@Northstar.test');
  });
});
