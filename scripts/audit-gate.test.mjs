import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate } from './audit-gate.mjs';

const { exceptions } = JSON.parse(
  readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8'),
);
const today = '2026-11-17';

const advisory = (overrides = {}) => ({
  github_advisory_id: 'GHSA-fc5q-39xc-vjpf',
  module_name: 'picomatch',
  severity: 'high',
  patched_versions: null,
  findings: [
    {
      version: '4.0.7',
      paths: ['apps__portal>vite>picomatch', '.>vitest>tinyglobby>fdir>picomatch'],
    },
  ],
  ...overrides,
});
const report = (...advisories) => ({
  advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])),
});
const empty = report();

describe('dependency audit gate', () => {
  it('excepts the named advisory on its recorded development paths', () => {
    const result = evaluate({ full: report(advisory()), prod: empty, exceptions, today });
    expect(result.failures).toEqual([]);
    expect(result.excepted).toHaveLength(1);
  });

  it('still fails any other high or critical advisory, including other picomatch advisories', () => {
    for (const other of [
      advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      advisory({ github_advisory_id: 'GHSA-dddd-eeee-ffff', severity: 'critical' }),
      advisory({ github_advisory_id: 'GHSA-1111-2222-3333', module_name: 'express' }),
    ]) {
      const result = evaluate({
        full: report(advisory(), other),
        prod: empty,
        exceptions,
        today,
      });
      expect(result.failures).toEqual([expect.stringContaining('no exception')]);
    }
  });

  it('does not fail on moderate advisories (unchanged behaviour)', () => {
    const moderate = advisory({ github_advisory_id: 'GHSA-3g3m-2fjr-6pw4', severity: 'moderate' });
    expect(
      evaluate({ full: report(advisory(), moderate), prod: empty, exceptions, today }).failures,
    ).toEqual([]);
  });

  it('fails when the advisory reaches a production dependency', () => {
    const result = evaluate({
      full: report(advisory()),
      prod: report(advisory()),
      exceptions,
      today,
    });
    expect(result.failures).toEqual([expect.stringContaining('production dependency')]);
  });

  it('fails on a path, version or package outside the exception', () => {
    const outside = [
      advisory({ findings: [{ version: '4.0.7', paths: ['services__api-gateway>x>picomatch'] }] }),
      advisory({ findings: [{ version: '4.0.8', paths: ['apps__portal>vite>picomatch'] }] }),
      advisory({ module_name: 'micromatch' }),
    ];
    for (const a of outside) {
      expect(
        evaluate({ full: report(a), prod: empty, exceptions, today }).failures.length,
      ).toBeGreaterThan(0);
    }
  });

  it('expires after the review date and once a patched version exists', () => {
    expect(
      evaluate({ full: report(advisory()), prod: empty, exceptions, today: '2026-12-02' }).failures,
    ).toEqual([expect.stringContaining('expired')]);
    expect(
      evaluate({
        full: report(advisory({ patched_versions: '>=4.0.8' })),
        prod: empty,
        exceptions,
        today,
      }).failures,
    ).toEqual([expect.stringContaining('patched version is available')]);
  });

  it('fails when an exception is no longer needed, and fails closed on unreadable output', () => {
    expect(evaluate({ full: empty, prod: empty, exceptions, today }).failures).toEqual([
      expect.stringContaining('no longer matches'),
    ]);
    expect(evaluate({ full: undefined, prod: empty, exceptions, today }).failures).toEqual([
      expect.stringContaining('failing closed'),
    ]);
  });
});
