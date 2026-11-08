#!/usr/bin/env node
/**
 * Creates .env from .env.example for local development:
 *  - replaces each __GENERATE__ with a random 24-byte hex value (URL-safe, local-only)
 *  - expands ${VAR} references to values defined earlier in the file
 * Refuses to overwrite an existing .env.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const target = join(root, '.env');
if (existsSync(target)) {
  console.log('.env already exists; leaving it unchanged. Delete it first to regenerate.');
  process.exit(0);
}

const values = {};
const output = readFileSync(join(root, '.env.example'), 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key, raw] = match;
    let value = raw === '__GENERATE__' ? randomBytes(24).toString('hex') : raw;
    value = value.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      if (!(name in values))
        throw new Error(`${key} references ${name}, which is not defined above it`);
      return values[name];
    });
    values[key] = value;
    return `${key}=${value}`;
  })
  .join('\n');

writeFileSync(target, output, { mode: 0o600 });
console.log('Created .env with generated local-only credentials (file mode 600).');
