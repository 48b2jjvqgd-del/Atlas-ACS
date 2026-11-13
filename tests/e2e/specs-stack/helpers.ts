import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

const envFile = join(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const password = process.env.ATLAS_DEMO_PASSWORD!;
const secret = process.env.ATLAS_DEMO_TOTP_SECRET!;

function totp(time = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * One-time codes are single-use per account; wait for a fresh one when this account already used
 * the current code. The record file is shared with the system tests (tests/system/client.ts).
 */
async function freshCode(email: string): Promise<string> {
  const key = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  const file = join(tmpdir(), `atlas-system-tests-last-totp-${key}`);
  for (;;) {
    const code = totp();
    if (!existsSync(file) || readFileSync(file, 'utf8') !== code) {
      writeFileSync(file, code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Signs in through the portal button and Keycloak's real login form. */
export async function signInAs(page: Page, email: string) {
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  if (email.endsWith('@atlas.test')) {
    await page.locator('#otp').fill(await freshCode(email));
    await page.locator('#kc-login').click();
  }
  await expect(page.getByTestId('auth-status').getByRole('button')).toBeVisible();
}

export async function signOut(page: Page) {
  await page.goto('/account');
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'You have signed out' })).toBeVisible();
}

export function shot(name: string) {
  return {
    path: join(import.meta.dirname, '..', 'screenshots', `${name}.png`),
    fullPage: true,
  } as const;
}
