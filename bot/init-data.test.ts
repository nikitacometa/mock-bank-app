import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InitDataError,
  parseTmaAuthorization,
  validateTelegramInitData,
} from './init-data.js';

const TEST_TOKEN = ['123456', 'synthetic_token_that_is_long_enough_for_tests'].join(':');
const NOW = 1_700_000_000;

function signedInitData(
  fields: Readonly<Record<string, string>>,
  token = TEST_TOKEN,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.append('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

function userJson(id: number | string = 42): string {
  return JSON.stringify({
    id,
    first_name: 'A+B /',
    language_code: 'en-US',
  });
}

function expectCode(run: () => unknown, code: InitDataError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InitDataError);
    expect((error as InitDataError).code).toBe(code);
    return;
  }
  throw new Error(`Expected InitDataError: ${code}`);
}

describe('validateTelegramInitData', () => {
  it('validates decoded fields in sorted order and preserves user ID as a decimal string', () => {
    const raw = signedInitData({
      user: userJson(),
      signature: 'signed+fixture/value',
      query_id: 'synthetic+query',
      auth_date: String(NOW),
    });

    const result = validateTelegramInitData(raw, TEST_TOKEN, { nowSeconds: NOW });

    expect(result).toEqual({
      authDate: NOW,
      queryId: 'synthetic+query',
      user: {
        id: '42',
        firstName: 'A+B /',
        languageCode: 'en-US',
      },
    });
  });

  it('keeps signature in the HMAC input', () => {
    const raw = signedInitData({
      auth_date: String(NOW),
      signature: 'original-signature',
      user: userJson(),
    }).replace('original-signature', 'tampered-signature');

    expectCode(
      () => validateTelegramInitData(raw, TEST_TOKEN, { nowSeconds: NOW }),
      'signature',
    );
  });

  it('rejects tampering, a wrong token, malformed hashes, and duplicate keys', () => {
    const raw = signedInitData({ auth_date: String(NOW), user: userJson() });
    expectCode(
      () => validateTelegramInitData(raw.replace('A%2BB', 'Eve'), TEST_TOKEN, { nowSeconds: NOW }),
      'signature',
    );
    expectCode(
      () => validateTelegramInitData(raw, `${TEST_TOKEN}x`, { nowSeconds: NOW }),
      'signature',
    );
    expectCode(
      () => validateTelegramInitData(raw.replace(/hash=[a-f0-9]{64}/, 'hash=abc'), TEST_TOKEN, { nowSeconds: NOW }),
      'malformed',
    );
    expectCode(
      () => validateTelegramInitData(`${raw}&auth_date=${NOW}`, TEST_TOKEN, { nowSeconds: NOW }),
      'malformed',
    );
  });

  it('accepts the exact 24-hour boundary and rejects one second older', () => {
    const boundary = signedInitData({
      auth_date: String(NOW - 86_400),
      user: userJson(),
    });
    const stale = signedInitData({
      auth_date: String(NOW - 86_401),
      user: userJson(),
    });

    expect(validateTelegramInitData(boundary, TEST_TOKEN, { nowSeconds: NOW }).authDate)
      .toBe(NOW - 86_400);
    expectCode(
      () => validateTelegramInitData(stale, TEST_TOKEN, { nowSeconds: NOW }),
      'stale',
    );
  });

  it('allows 30 seconds of future skew but rejects the next second', () => {
    const boundary = signedInitData({ auth_date: String(NOW + 30), user: userJson() });
    const future = signedInitData({ auth_date: String(NOW + 31), user: userJson() });

    expect(validateTelegramInitData(boundary, TEST_TOKEN, { nowSeconds: NOW }).authDate)
      .toBe(NOW + 30);
    expectCode(
      () => validateTelegramInitData(future, TEST_TOKEN, { nowSeconds: NOW }),
      'future',
    );
  });

  it('rejects signed malformed users and unsafe numeric IDs', () => {
    const malformed = signedInitData({ auth_date: String(NOW), user: '[]' });
    const unsafe = signedInitData({
      auth_date: String(NOW),
      user: userJson(Number.MAX_SAFE_INTEGER + 1),
    });

    expectCode(
      () => validateTelegramInitData(malformed, TEST_TOKEN, { nowSeconds: NOW }),
      'user',
    );
    expectCode(
      () => validateTelegramInitData(unsafe, TEST_TOKEN, { nowSeconds: NOW }),
      'user',
    );
  });

  it('rejects malformed percent escapes and oversized input before HMAC work', () => {
    expectCode(
      () => validateTelegramInitData('auth_date=%ZZ&hash=x', TEST_TOKEN, { nowSeconds: NOW }),
      'malformed',
    );
    expectCode(
      () => validateTelegramInitData(`x=${'a'.repeat(8_193)}`, TEST_TOKEN, { nowSeconds: NOW }),
      'malformed',
    );
  });
});

describe('parseTmaAuthorization', () => {
  it('accepts only the exact lowercase tma scheme without outer whitespace', () => {
    expect(parseTmaAuthorization('tma auth_date=1&hash=x')).toBe('auth_date=1&hash=x');
    expect(() => parseTmaAuthorization('TMA auth_date=1')).toThrow();
    expect(() => parseTmaAuthorization('tma  auth_date=1')).toThrow();
    expect(() => parseTmaAuthorization(undefined)).toThrow();
  });
});
