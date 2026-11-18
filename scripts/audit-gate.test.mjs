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
  // pnpm 12's representation of "no fix available" (verified against raw `pnpm audit --json`).
  patched_versions: null,
  patched_versions_unpublished: true,
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
    // Two independent reasons: production may never hold a high advisory, and the exception does
    // not cover production paths.
    expect(result.failures).toEqual([
      expect.stringContaining('exceptions never apply to production dependencies'),
      expect.stringContaining('reaches a production dependency'),
    ]);
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
        full: report(
          advisory({ patched_versions: '>=4.0.8', patched_versions_unpublished: undefined }),
        ),
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

// Regression tests for fail-open cases found in review: the gate must positively establish that
// every affected path is in scope. Missing, empty or malformed evidence is a failure, never a pass.
describe('dependency audit gate fails closed', () => {
  const failuresFor = (a, options = {}) =>
    evaluate({
      full: report(a),
      prod: options.prod ?? empty,
      exceptions: options.exceptions ?? exceptions,
      today: options.today ?? today,
    }).failures;

  it('fails an advisory with missing findings', () => {
    const { findings: _omitted, ...withoutFindings } = advisory();
    expect(failuresFor(withoutFindings)).toEqual([expect.stringContaining('no findings')]);
    expect(failuresFor(advisory({ findings: null }))).toEqual([
      expect.stringContaining('no findings'),
    ]);
  });

  it('fails an advisory with an empty findings array', () => {
    expect(failuresFor(advisory({ findings: [] }))).toEqual([
      expect.stringContaining('no findings'),
    ]);
  });

  it('fails a finding with missing paths', () => {
    expect(failuresFor(advisory({ findings: [{ version: '4.0.7' }] }))).toEqual([
      expect.stringContaining('no dependency paths'),
    ]);
  });

  it('fails a finding with an empty paths array', () => {
    expect(failuresFor(advisory({ findings: [{ version: '4.0.7', paths: [] }] }))).toEqual([
      expect.stringContaining('no dependency paths'),
    ]);
  });

  it('fails malformed findings and path data', () => {
    for (const findings of [
      'apps__portal>vite>picomatch',
      [null],
      ['apps__portal>vite>picomatch'],
      [{ version: '4.0.7', paths: 'apps__portal>vite>picomatch' }],
      [{ version: '4.0.7', paths: [42] }],
      [{ version: '4.0.7', paths: [''] }],
      [{ version: '4.0.7', paths: [null, 'apps__portal>vite>picomatch'] }],
      [{ paths: ['apps__portal>vite>picomatch'] }],
    ]) {
      expect(failuresFor(advisory({ findings })).length, JSON.stringify(findings)).toBeGreaterThan(
        0,
      );
    }
  });

  it('fails when the severity does not match the recorded severity', () => {
    expect(failuresFor(advisory({ severity: 'critical' }))).toEqual([
      expect.stringContaining('does not match the recorded high'),
    ]);
  });

  it('fails one permitted development path alongside one unapproved production path', () => {
    const mixed = advisory({
      findings: [
        {
          version: '4.0.7',
          paths: ['apps__portal>vite>picomatch', 'services__api-gateway>fastify>picomatch'],
        },
      ],
    });
    expect(failuresFor(mixed)).toEqual([
      expect.stringContaining(
        'path outside the exception: services__api-gateway>fastify>picomatch',
      ),
    ]);
    // And when the production-only audit sees it, independently of the path check.
    expect(failuresFor(mixed, { prod: report(mixed) })).toEqual(
      expect.arrayContaining([
        expect.stringContaining('exceptions never apply to production'),
        expect.stringContaining('reaches a production dependency'),
      ]),
    );
  });

  it('still accepts every approved development path before expiry', () => {
    const allApproved = advisory({
      findings: [
        {
          version: '4.0.7',
          paths: [
            'apps__portal>vite>picomatch',
            'apps__portal>@vitejs/plugin-react>vite>tinyglobby>picomatch',
            'apps__portal>@tailwindcss/vite>vite>tinyglobby>fdir>picomatch',
            '.>vitest>@vitest/mocker>vite>picomatch',
            '.>typescript-eslint>@typescript-eslint/typescript-estree>tinyglobby>picomatch',
          ],
        },
      ],
    });
    for (const day of ['2026-11-17', '2026-11-30']) {
      const result = evaluate({ full: report(allApproved), prod: empty, exceptions, today: day });
      expect(result.failures, day).toEqual([]);
      expect(result.excepted, day).toEqual([expect.stringContaining('5 development path(s)')]);
    }
  });

  it('is no longer accepted on 1 December 2026 (expires at the start of the review date)', () => {
    expect(failuresFor(advisory(), { today: '2026-12-01' })).toEqual([
      expect.stringContaining('expired at 00:00 UTC on 2026-12-01'),
    ]);
  });

  it('continues to fail other high and critical advisories, and unknown severities', () => {
    for (const other of [
      advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      advisory({ github_advisory_id: 'GHSA-dddd-eeee-ffff', severity: 'critical' }),
      advisory({ github_advisory_id: 'GHSA-1111-2222-3333', module_name: 'fastify' }),
    ]) {
      expect(
        evaluate({ full: report(advisory(), other), prod: empty, exceptions, today }).failures,
      ).toEqual([expect.stringContaining('no exception')]);
    }
    for (const severity of ['HIGH', 'severe', undefined, null]) {
      const unknown = advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc', severity });
      expect(
        evaluate({ full: report(advisory(), unknown), prod: empty, exceptions, today }).failures,
        String(severity),
      ).toEqual([expect.stringContaining('unknown or missing severity')]);
    }
  });

  it('is invalidated by a published patched version', () => {
    expect(
      failuresFor(
        advisory({ patched_versions: '>=4.0.8', patched_versions_unpublished: undefined }),
      ),
    ).toEqual([expect.stringContaining('patched version is available')]);
    expect(failuresFor(advisory({ patched_versions: 4 }))).toEqual([
      expect.stringContaining('malformed patched_versions'),
    ]);
  });

  // F-07 (final review): "no fix exists" must be stated explicitly by the audit output; the absence
  // of a patched version is not evidence that none exists.
  describe('requires explicit evidence that no fix exists', () => {
    const { patched_versions: _p, ...withoutPatched } = advisory();

    it('accepts only pnpm’s explicit no-fix representation', () => {
      expect(failuresFor(advisory())).toEqual([]);
    });

    it('fails when patched_versions is missing', () => {
      expect(failuresFor(withoutPatched)).toEqual([
        expect.stringContaining('patched_versions missing'),
      ]);
      const { patched_versions_unpublished: _u, ...neither } = withoutPatched;
      expect(failuresFor(neither)).toEqual([expect.stringContaining('patched_versions missing')]);
    });

    it('fails when patched_versions is null without the unpublished flag', () => {
      for (const unpublished of [undefined, false, null, 'true', 1]) {
        const a = advisory({ patched_versions_unpublished: unpublished });
        if (unpublished === undefined) delete a.patched_versions_unpublished;
        expect(failuresFor(a), String(unpublished)).toEqual([
          expect.stringContaining('cannot establish that no fix exists'),
        ]);
      }
    });

    it('fails on an unexpected type', () => {
      for (const patched of [4, true, false, {}, [], ['>=4.0.8']]) {
        expect(
          failuresFor(advisory({ patched_versions: patched })),
          JSON.stringify(patched),
        ).toEqual([expect.stringContaining('malformed patched_versions')]);
      }
    });

    it('fails on malformed or contradictory values', () => {
      for (const [patched, unpublished] of [
        ['', true],
        ['', undefined],
        ['<0.0.0', undefined], // npm's older form; not what pnpm 12 emits, so not accepted
        ['<0.0.0', true],
        ['>=4.0.8', true], // a range *and* "unpublished": contradictory
        ['>=4.0.8', false],
      ]) {
        const a = advisory({
          patched_versions: patched,
          patched_versions_unpublished: unpublished,
        });
        if (unpublished === undefined) delete a.patched_versions_unpublished;
        expect(failuresFor(a), JSON.stringify([patched, unpublished])).toEqual([
          expect.stringContaining('cannot establish that no fix exists'),
        ]);
      }
    });

    it('fails when a patched version exists', () => {
      for (const patched of ['>=4.0.8', '>=4.0.8 <5.0.0 || >=5.0.1']) {
        const a = advisory({ patched_versions: patched });
        delete a.patched_versions_unpublished;
        expect(failuresFor(a), patched).toEqual([
          expect.stringContaining('patched version is available'),
        ]);
      }
    });
  });

  it('fails closed on unreadable or malformed audit output', () => {
    for (const [full, prod] of [
      [undefined, empty],
      [empty, undefined],
      [null, empty],
      ['{"advisories":{}}', empty],
      [{ advisories: [] }, empty],
      [{ advisories: 'x' }, empty],
      [{ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, empty],
      [empty, { advisories: [] }],
    ]) {
      expect(evaluate({ full, prod, exceptions: [], today }).failures).toEqual([
        expect.stringContaining('failing closed'),
      ]);
    }
    expect(evaluate({ full: report(null), prod: empty, exceptions: [], today }).failures).toEqual([
      expect.stringContaining('malformed'),
    ]);
    expect(
      evaluate({ full: report(advisory()), prod: empty, exceptions, today: 'tomorrow' }).failures,
    ).toEqual([expect.stringContaining('failing closed')]);
  });

  it('fails when the exception register itself is incomplete or malformed', () => {
    const [entry] = exceptions;
    for (const broken of [
      { ...entry, reviewBy: undefined },
      { ...entry, reviewBy: '2026-13-01' },
      { ...entry, severity: undefined },
      { ...entry, severity: 'moderate' },
      { ...entry, allowedPaths: [] },
      { ...entry, allowedPaths: ['apps__portal'] },
      { ...entry, versions: [] },
      { ...entry, ghsa: 'not-an-id' },
      { ...entry, owner: '' },
    ]) {
      expect(
        failuresFor(advisory(), { exceptions: [broken] }).length,
        JSON.stringify(broken),
      ).toBeGreaterThan(0);
    }
    expect(failuresFor(advisory(), { exceptions: [entry, entry] })).toEqual([
      expect.stringContaining('duplicate'),
    ]);
    expect(failuresFor(advisory(), { exceptions: 'none' })).toEqual([
      expect.stringContaining('not a list'),
    ]);
  });
});
