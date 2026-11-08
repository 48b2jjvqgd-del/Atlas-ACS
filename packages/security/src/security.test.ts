import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  maskPan,
  passesLuhn,
  redactSensitive,
  redactUrlCredentials,
  resolveSecret,
  scrubCardNumbers,
} from './index.js';

// Well-known public test PANs (Luhn-valid, not real accounts).
const TEST_PAN = '4111111111111111';
const TEST_PAN_19 = '6011000990139424124'; // synthetic, Luhn-valid

describe('passesLuhn', () => {
  it('accepts Luhn-valid numbers and rejects invalid ones', () => {
    expect(passesLuhn(TEST_PAN)).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('41a1')).toBe(false);
    expect(passesLuhn('')).toBe(false);
  });
});

describe('maskPan', () => {
  it('keeps at most the first six and last four digits', () => {
    expect(maskPan(TEST_PAN)).toBe('411111******1111');
    expect(maskPan('4111 1111 1111 1111')).toBe('411111******1111');
  });

  it('fully redacts values too short to be a PAN', () => {
    expect(maskPan('12345')).toBe(REDACTED);
  });
});

describe('scrubCardNumbers', () => {
  it('masks Luhn-valid card numbers embedded in text, including separated forms', () => {
    const text = `card ${TEST_PAN} and 4111-1111-1111-1111 failed`;
    const scrubbed = scrubCardNumbers(text);
    expect(scrubbed).not.toContain(TEST_PAN);
    expect(scrubbed).not.toContain('4111-1111-1111-1111');
    expect(scrubbed).toContain('411111******1111');
  });

  it('leaves non-card numbers such as timestamps and Luhn-invalid sequences untouched', () => {
    expect(scrubCardNumbers('ts=1730937600000 id=4111111111111112')).toBe(
      'ts=1730937600000 id=4111111111111112',
    );
  });
});

describe('redactSensitive', () => {
  it('redacts sensitive keys regardless of case and separators', () => {
    expect(isSensitiveKey('X-API-KEY')).toBe(true);
    expect(isSensitiveKey('acct_number')).toBe(true);
    expect(isSensitiveKey('tenantId')).toBe(false);
  });

  it('deeply redacts EMV 3DS cardholder fields, secrets and stray PANs', () => {
    const input = {
      messageType: 'AReq',
      acctNumber: TEST_PAN,
      nested: { password: 'hunter2', otp: '123456', note: `pan ${TEST_PAN_19}` },
      list: [{ authenticationValue: 'AAABBBCCC' }],
    };
    const output = JSON.stringify(redactSensitive(input));
    for (const secret of [TEST_PAN, 'hunter2', '123456', TEST_PAN_19, 'AAABBBCCC']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('AReq');
  });

  it('survives circular structures', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    expect(redactSensitive(value)).toEqual({ name: 'loop', self: '[CIRCULAR]' });
  });
});

describe('resolveSecret', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-secret-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('reads a secret from a *_FILE path in preference to nothing', () => {
    const file = join(directory, 'db-password');
    writeFileSync(file, 's3cr3t-value\n');
    expect(resolveSecret({ DB_PASSWORD_FILE: file }, 'DB_PASSWORD')).toBe('s3cr3t-value');
  });

  it('rejects ambiguous configuration', () => {
    expect(() => resolveSecret({ X: 'a', X_FILE: '/tmp/x' }, 'X')).toThrow(/exactly one/);
  });

  it('does not leak the file path or contents when the file is missing', () => {
    expect(() => resolveSecret({ X_FILE: '/nonexistent/secret-path' }, 'X')).toThrow(
      'Secret file for X could not be read',
    );
  });
});

describe('redactUrlCredentials', () => {
  it('removes credentials from connection URLs', () => {
    const redacted = redactUrlCredentials('postgres://atlas:pa55word@db:5432/atlas');
    expect(redacted).not.toContain('pa55word');
    expect(redacted).toContain('db:5432');
  });
});
