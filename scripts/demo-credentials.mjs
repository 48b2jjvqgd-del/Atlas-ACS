#!/usr/bin/env node
/**
 * Prints the local demo sign-in details: the shared password of the synthetic accounts and the
 * current one-time code for platform accounts (pre-enrolled TOTP, RFC 6238, SHA-1, 6 digits, 30 s).
 * Local development only — these values exist only in your generated .env.
 */
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const password = process.env.ATLAS_DEMO_PASSWORD;
const secret = process.env.ATLAS_DEMO_TOTP_SECRET;
if (!password || !secret) {
  console.error('ATLAS_DEMO_PASSWORD / ATLAS_DEMO_TOTP_SECRET missing: run pnpm setup:env');
  process.exit(1);
}

export function totp(key, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', Buffer.from(key, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`Password (all synthetic accounts): ${password}`);
console.log(`One-time code (platform accounts):  ${totp(secret)}  (valid ~${remaining}s)`);
console.log('Accounts: super.admin@atlas.test, platform.admin@atlas.test, tech.admin@atlas.test,');
console.log(
  '          admin@northstar.test, support@northstar.test, admin@meridian.test, ... (docs/DEVELOPMENT.md)',
);
