import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TelegramUserIdentity } from './model.js';

const MAX_INIT_DATA_BYTES = 8 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;

export type InitDataErrorCode =
  | 'malformed'
  | 'signature'
  | 'stale'
  | 'future'
  | 'user';

export class InitDataError extends Error {
  readonly code: InitDataErrorCode;

  constructor(code: InitDataErrorCode) {
    super(`Invalid Telegram init data: ${code}`);
    this.name = 'InitDataError';
    this.code = code;
  }
}

export interface ValidatedInitData {
  readonly authDate: number;
  readonly queryId?: string;
  readonly user: TelegramUserIdentity;
}

interface InitDataValidationOptions {
  readonly nowSeconds?: number;
  readonly maxAgeSeconds?: number;
}

function parseDecimalUserId(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value.toString(10);
  }
  return null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InitDataError('user');
  return value;
}

function parseUser(raw: string): TelegramUserIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new InitDataError('user');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InitDataError('user');
  }
  const record = value as Record<string, unknown>;
  const id = parseDecimalUserId(record.id);
  if (id === null) throw new InitDataError('user');
  return {
    id,
    firstName: optionalString(record, 'first_name'),
    lastName: optionalString(record, 'last_name'),
    username: optionalString(record, 'username'),
    languageCode: optionalString(record, 'language_code'),
  };
}

export function validateTelegramInitData(
  rawInitData: string,
  botToken: string,
  options: InitDataValidationOptions = {},
): ValidatedInitData {
  if (
    rawInitData === '' ||
    Buffer.byteLength(rawInitData, 'utf8') > MAX_INIT_DATA_BYTES ||
    /[\r\n\0]/.test(rawInitData) ||
    /%(?![0-9A-Fa-f]{2})/.test(rawInitData)
  ) {
    throw new InitDataError('malformed');
  }

  const params = new URLSearchParams(rawInitData);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (key === '' || seen.size >= 32) throw new InitDataError('malformed');
    if (seen.has(key)) throw new InitDataError('malformed');
    seen.add(key);
  }

  const receivedHash = params.get('hash');
  if (receivedHash === null || !/^[a-f0-9]{64}$/.test(receivedHash)) {
    throw new InitDataError('malformed');
  }
  // Bot-token HMAC covers every received field except `hash`. Telegram excludes
  // `signature` only from the separate third-party Ed25519 data-check-string.
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const receivedHashBytes = Buffer.from(receivedHash, 'hex');
  if (
    receivedHashBytes.length !== expectedHash.length ||
    !timingSafeEqual(receivedHashBytes, expectedHash)
  ) {
    throw new InitDataError('signature');
  }

  const rawAuthDate = params.get('auth_date');
  if (rawAuthDate === null || !/^\d{1,12}$/.test(rawAuthDate)) {
    throw new InitDataError('malformed');
  }
  const authDate = Number(rawAuthDate);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new InitDataError('malformed');
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new InitDataError('malformed');
  }
  if (authDate > nowSeconds + MAX_FUTURE_SKEW_SECONDS) throw new InitDataError('future');
  if (nowSeconds - authDate > maxAgeSeconds) throw new InitDataError('stale');

  const rawUser = params.get('user');
  if (rawUser === null) throw new InitDataError('user');
  const queryId = params.get('query_id') ?? undefined;
  return { authDate, queryId, user: parseUser(rawUser) };
}

export function parseTmaAuthorization(header: string | undefined): string {
  if (header === undefined || !header.startsWith('tma ')) {
    throw new InitDataError('malformed');
  }
  const rawInitData = header.slice(4);
  if (rawInitData === '' || rawInitData.trim() !== rawInitData) {
    throw new InitDataError('malformed');
  }
  return rawInitData;
}
