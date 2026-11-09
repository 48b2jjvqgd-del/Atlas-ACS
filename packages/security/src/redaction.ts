/**
 * Sensitive-data handling for logs and diagnostics.
 *
 * Two independent layers, because either alone is insufficient:
 *  1. Key-based redaction: values under known sensitive keys are replaced wholesale.
 *  2. Content-based scrubbing: free text is scanned for card-number-like digit sequences
 *     that pass the Luhn check, and these are masked wherever they appear.
 *
 * Neither layer is a substitute for not logging sensitive data in the first place.
 */

export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are never logged. Matching is case-insensitive and ignores "-" and "_",
 * so "x-api-key", "apiKey" and "API_KEY" are all caught. Includes EMV 3DS field names that
 * carry cardholder data or authentication material (acctNumber, authenticationValue, ...).
 */
export const sensitiveKeys = [
  // Credentials and secrets
  'password',
  'passwd',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'xAtlasUserToken',
  'userToken',
  'xAtlasCsrf',
  'csrfToken',
  'sessionId',
  'codeVerifier',
  'apiKey',
  'xApiKey',
  'authorization',
  'cookie',
  'setCookie',
  'privateKey',
  'otp',
  'oneTimePassword',
  'pin',
  'passcode',
  // Cardholder data
  'pan',
  'cardNumber',
  'acctNumber',
  'accountNumber',
  'cvv',
  'cvc',
  'cvv2',
  'cvc2',
  'securityCode',
  'track1',
  'track2',
  'expiryDate',
  'cardExpiryDate',
  // EMV 3DS authentication material
  'authenticationValue',
  'cavv',
  'aav',
  'sdkEphemPubKey',
  'acsEphemPubKey',
  'challengeData',
] as const;

const normalise = (key: string) => key.toLowerCase().replaceAll(/[-_]/g, '');
const sensitiveKeySet = new Set<string>(sensitiveKeys.map(normalise));

export function isSensitiveKey(key: string): boolean {
  return sensitiveKeySet.has(normalise(key));
}

/** Luhn (mod 10) check over a string of digits. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * Masks a PAN to first six / last four digits — the most that may be displayed under PCI DSS
 * requirement 3.4.1 for PANs of this length. ATLAS policy is to log even less where possible.
 */
export function maskPan(pan: string): string {
  const digits = pan.replaceAll(/\D/g, '');
  if (digits.length < 13) return REDACTED;
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}

// 13–19 digits, optionally separated by single spaces or hyphens, not embedded in a longer number.
const panCandidate = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

/** Masks every Luhn-valid card-number-like sequence in free text. */
export function scrubCardNumbers(text: string): string {
  return text.replaceAll(panCandidate, (match) => {
    const digits = match.replaceAll(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
      ? maskPan(digits)
      : match;
  });
}

/**
 * Deep-copies a value, replacing sensitive keys and scrubbing card numbers from strings.
 * Bounded depth protects against pathological or cyclic structures.
 */
export function redactSensitive(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubCardNumbers(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1, seen));
  if (value instanceof Error) {
    return { name: value.name, message: scrubCardNumbers(value.message) };
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(entry, depth + 1, seen);
  }
  return result;
}
