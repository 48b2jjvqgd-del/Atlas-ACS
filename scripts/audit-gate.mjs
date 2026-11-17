#!/usr/bin/env node
/**
 * Dependency audit gate (CI job "Dependency audit", `pnpm audit:deps`).
 *
 * Fails on every high or critical advisory, except one listed in scripts/audit-exceptions.json
 * for which the gate *positively establishes* that it is inside that exception's scope:
 *   - same advisory id, package and severity, and only the recorded versions;
 *   - at least one finding, each with at least one dependency path, and every path ending in the
 *     package and starting with one of the recorded development/build path prefixes;
 *   - the advisory does not appear in the production-only audit (`pnpm audit --prod`), which may
 *     never contain a high or critical advisory at all;
 *   - no patched version has been published;
 *   - the current UTC date is *before* `reviewBy`: the exception expires at 00:00 UTC on that date
 *     and is not accepted on it.
 * Fail closed: missing, empty or malformed evidence (audit output, advisories, findings, paths,
 * severities, the exception register itself) is a failure, never a pass. An exception that no
 * longer matches any advisory also fails, so it is removed promptly. Moderate and low advisories
 * are reported by pnpm but do not fail the gate (unchanged).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const BLOCKING = new Set(['high', 'critical']);
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
/** A real calendar date in YYYY-MM-DD form (rejects e.g. 2026-13-01 and 2026-02-30). */
const isDate = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const isTextList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);

/** Problems with the exception register; any problem fails the gate. */
export function validateExceptions(exceptions) {
  if (!Array.isArray(exceptions)) return ['exception register is not a list'];
  const problems = [];
  const seen = new Set();
  exceptions.forEach((e, index) => {
    const name = isObject(e) && isText(e.ghsa) ? e.ghsa : `entry ${index}`;
    if (!isObject(e)) return problems.push(`${name}: not an object`);
    if (!isText(e.ghsa) || !GHSA.test(e.ghsa)) problems.push(`${name}: invalid ghsa`);
    if (seen.has(e.ghsa)) problems.push(`${name}: duplicate exception`);
    seen.add(e.ghsa);
    if (!isText(e.package)) problems.push(`${name}: invalid package`);
    if (!BLOCKING.has(e.severity)) problems.push(`${name}: severity must be high or critical`);
    if (!isTextList(e.versions)) problems.push(`${name}: versions must be a non-empty list`);
    if (!isTextList(e.allowedPaths) || !e.allowedPaths.every((prefix) => prefix.endsWith('>')))
      problems.push(`${name}: allowedPaths must be a non-empty list of prefixes ending in ">"`);
    if (!isDate(e.reviewBy)) problems.push(`${name}: reviewBy must be a valid YYYY-MM-DD date`);
    if (!isText(e.owner)) problems.push(`${name}: owner is required`);
  });
  return problems;
}

/** Problems that keep an advisory outside its exception's scope (empty = in scope). */
function scopeProblems(advisory, exception, prodIds, today) {
  const problems = [];
  if (advisory.module_name !== exception.package)
    problems.push(`package ${advisory.module_name} is not ${exception.package}`);
  if (advisory.severity !== exception.severity)
    problems.push(
      `severity ${advisory.severity} does not match the recorded ${exception.severity}`,
    );
  if (today >= exception.reviewBy)
    problems.push(`exception expired at 00:00 UTC on ${exception.reviewBy}`);
  const patched = advisory.patched_versions;
  if (patched !== null && patched !== undefined && patched !== '<0.0.0') {
    problems.push(
      isText(patched)
        ? `a patched version is available (${patched}): upgrade and remove the exception`
        : 'malformed patched_versions',
    );
  }
  if (prodIds.has(advisory.github_advisory_id)) problems.push('reaches a production dependency');

  const findings = advisory.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    problems.push('no findings: the affected dependency paths cannot be established');
    return problems;
  }
  findings.forEach((finding, index) => {
    if (!isObject(finding)) return problems.push(`finding ${index}: malformed`);
    if (!isText(finding.version) || !exception.versions.includes(finding.version))
      problems.push(`finding ${index}: version ${String(finding.version)} is not covered`);
    const paths = finding.paths;
    if (!Array.isArray(paths) || paths.length === 0)
      return problems.push(`finding ${index}: no dependency paths`);
    paths.forEach((path) => {
      if (!isText(path)) return problems.push(`finding ${index}: malformed path`);
      const inScope =
        path.endsWith(`>${exception.package}`) &&
        exception.allowedPaths.some((prefix) => path.startsWith(prefix));
      if (!inScope) problems.push(`path outside the exception: ${path}`);
    });
  });
  return problems;
}

/** @returns {{ failures: string[], excepted: string[] }} */
export function evaluate({ full, prod, exceptions, today }) {
  const excepted = [];
  if (
    !isObject(full) ||
    !isObject(full.advisories) ||
    !isObject(prod) ||
    !isObject(prod.advisories)
  )
    return { failures: ['audit output unreadable or malformed: failing closed'], excepted };
  if (!isDate(today))
    return { failures: [`invalid current date ${today}: failing closed`], excepted };
  const registerProblems = validateExceptions(exceptions);
  if (registerProblems.length)
    return { failures: registerProblems.map((p) => `exception register: ${p}`), excepted };

  const failures = [];
  const severityOf = (advisory, key, scope) => {
    if (!isObject(advisory)) {
      failures.push(`${scope} advisory ${key}: malformed`);
      return undefined;
    }
    if (!SEVERITIES.has(advisory.severity)) {
      failures.push(
        `${scope} advisory ${String(advisory.github_advisory_id ?? key)}: unknown or missing severity ${JSON.stringify(advisory.severity)}`,
      );
      return undefined;
    }
    return advisory.severity;
  };

  // Production: no exception ever applies. Any high or critical advisory fails.
  const prodIds = new Set();
  for (const [key, advisory] of Object.entries(prod.advisories)) {
    const severity = severityOf(advisory, key, 'production');
    if (!severity) continue;
    prodIds.add(advisory.github_advisory_id);
    if (BLOCKING.has(severity))
      failures.push(
        `production advisory ${String(advisory.github_advisory_id)} (${severity}, ${String(advisory.module_name)}): exceptions never apply to production dependencies`,
      );
  }

  const used = new Set();
  for (const [key, advisory] of Object.entries(full.advisories)) {
    const severity = severityOf(advisory, key, 'audit');
    if (!severity || !BLOCKING.has(severity)) continue;
    const id = advisory.github_advisory_id;
    const label = `${String(id)} (${severity}, ${String(advisory.module_name)})`;
    const exception = isText(id) ? exceptions.find((e) => e.ghsa === id) : undefined;
    if (!exception) {
      failures.push(`${label}: no exception`);
      continue;
    }
    used.add(id);
    const problems = scopeProblems(advisory, exception, prodIds, today);
    if (problems.length) {
      failures.push(...problems.map((p) => `${label}: ${p}`));
    } else {
      const paths = advisory.findings.reduce((count, f) => count + f.paths.length, 0);
      excepted.push(
        `${label}: ${paths} development path(s) verified; accepted before ${exception.reviewBy} (expires 00:00 UTC that day; ${exception.owner})`,
      );
    }
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
  const today = new Date().toISOString().slice(0, 10); // UTC date
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
