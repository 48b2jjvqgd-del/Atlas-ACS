#!/usr/bin/env node
/**
 * Creates or completes .env from .env.example for local development:
 *  - __GENERATE__      → a random 24-byte hex value (URL-safe, local-only)
 *  - __GENERATE_KEY__  → a random 32-byte hex value (encryption keys)
 *  - ${VAR} references are expanded to values defined earlier (in .env or the example)
 *
 * An existing .env is never overwritten: keys it already has are kept as they are, and keys that
 * are new in .env.example (e.g. after pulling a new stage) are appended with generated values.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const target = join(root, '.env');
const parse = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );

const existing = existsSync(target) ? parse(readFileSync(target, 'utf8')) : {};
const values = { ...existing };
const added = [];

const lines = readFileSync(join(root, '.env.example'), 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key, raw] = match;
    if (key in existing) return undefined;
    let value =
      raw === '__GENERATE__'
        ? randomBytes(24).toString('hex')
        : raw === '__GENERATE_KEY__'
          ? randomBytes(32).toString('hex')
          : raw;
    value = value.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      if (!(name in values))
        throw new Error(`${key} references ${name}, which is not defined above it`);
      return values[name];
    });
    values[key] = value;
    added.push(key);
    return `${key}=${value}`;
  });

if (!existsSync(target)) {
  writeFileSync(target, lines.filter((line) => line !== undefined).join('\n'), { mode: 0o600 });
  console.log('Created .env with generated local-only credentials (file mode 600).');
} else if (added.length === 0) {
  console.log('.env is complete; nothing to add.');
} else {
  const appended = lines.filter(
    (line) => line && /^[A-Z0-9_]+=/.test(line) && added.includes(line.split('=')[0]),
  );
  const current = readFileSync(target, 'utf8').replace(/\n*$/, '\n');
  writeFileSync(
    target,
    `${current}\n# ---- Added by pnpm setup:env (${new Date().toISOString().slice(0, 10)})\n${appended.join('\n')}\n`,
  );
  chmodSync(target, 0o600);
  console.log(`Added ${added.length} new key(s) to .env: ${added.join(', ')}`);
}
