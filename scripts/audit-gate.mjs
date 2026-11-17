#!/usr/bin/env node
/**
 * Dependency audit gate (CI job "Dependency audit").
 *
 * Fails on every high or critical advisory, except one listed in scripts/audit-exceptions.json
 * whose every finding is still inside that exception's scope:
 *   - same advisory id and package, and only the recorded versions;
 *   - every dependency path starts with one of the recorded development/build paths;
 *   - the advisory does not appear in the production-only audit (`pnpm audit --prod`);
 *   - the review date has not passed, and no patched version has been published.
 * An exception that no longer matches any finding also fails, so it is removed promptly.
 * Moderate and low advisories are reported by pnpm but do not fail the gate (unchanged).
 * Anything unexpected (registry errors, unreadable output) fails closed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

/** @returns {{ failures: string[], excepted: string[] }} */
export function evaluate({ full, prod, exceptions, today }) {
  const failures = [];
  const excepted = [];
  if (!full?.advisories || !prod?.advisories) {
    return { failures: ['audit output unreadable: failing closed'], excepted };
  }
  const used = new Set();
  const prodIds = new Set(Object.values(prod.advisories).map((a) => a.github_advisory_id));

  for (const advisory of Object.values(full.advisories)) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const id = advisory.github_advisory_id;
    const label = `${id} (${advisory.severity}, ${advisory.module_name})`;
    const exception = exceptions.find((e) => e.ghsa === id);
    if (!exception) {
      failures.push(`${label}: no exception`);
      continue;
    }
    used.add(id);
    const problems = [];
    if (advisory.module_name !== exception.package)
      problems.push(`package ${advisory.module_name} is not ${exception.package}`);
    if (today > exception.reviewBy) problems.push(`exception expired on ${exception.reviewBy}`);
    const patched = advisory.patched_versions;
    if (patched && patched !== '<0.0.0')
      problems.push(
        `a patched version is available (${patched}): upgrade and remove the exception`,
      );
    if (prodIds.has(id)) problems.push('reaches a production dependency');
    for (const finding of advisory.findings ?? []) {
      if (!exception.versions.includes(finding.version))
        problems.push(`version ${finding.version} is not covered`);
      for (const path of finding.paths ?? []) {
        const inScope =
          path.endsWith(`>${exception.package}`) &&
          exception.allowedPaths.some((prefix) => path.startsWith(prefix));
        if (!inScope) problems.push(`path outside the exception: ${path}`);
      }
    }
    if (problems.length) failures.push(...problems.map((p) => `${label}: ${p}`));
    else excepted.push(`${label}: excepted until ${exception.reviewBy} (${exception.owner})`);
  }
  for (const exception of exceptions) {
    if (!used.has(exception.ghsa))
      failures.push(`${exception.ghsa}: exception no longer matches any advisory; remove it`);
  }
  return { failures, excepted };
}

function audit(args) {
  const result = spawnSync('pnpm', ['audit', '--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { exceptions } = JSON.parse(
    readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8'),
  );
  const today = new Date().toISOString().slice(0, 10);
  const { failures, excepted } = evaluate({
    full: audit([]),
    prod: audit(['--prod']),
    exceptions,
    today,
  });
  for (const line of excepted) console.log(`EXCEPTED  ${line}`);
  for (const line of failures) console.error(`FAIL      ${line}`);
  if (failures.length) process.exit(1);
  console.log('Dependency audit gate passed: no unexcepted high or critical advisories.');
}
