import { canonicalBankStateJson, parseBankState } from '@/domain/bankState';
import type { BankCommandOutcome } from '@/domain/bankCommands';
import type { BankState, Money } from '@/domain/types';
import { isAppLocale } from '@/i18n/catalog';
import { SUPPORTED_CURRENCIES } from '@/domain/currency';
import { isIsoTimestamp } from '@/domain/inputValidation';
import type {
  BankCommandResponse,
  BankImportResponse,
  BankRatesRefreshResponse,
  LaunchPreferences,
  LaunchState,
  ServerBankRevision,
  ServerBankWarning,
  SuccessfulBankCommandOutcome,
} from './types';

const TELEGRAM_ID_PATTERN = /^[1-9]\d{0,19}$/;
const REVISION_EPOCH_PATTERN = /^[0-9a-f]{32}$/;
const STATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const WARNING_REASONS = ['capacity', 'overflow', 'insufficient_funds'] as const;
const MAX_DISPLAY_NAME_CODE_POINTS = 48;
const DISALLOWED_DISPLAY_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNICODE_SEPARATORS = /\p{Z}+/gu;
/**
 * Device time is not authoritative for ledger validation. This deliberately
 * broad bound tolerates a realistically misconfigured client clock while
 * rejecting a corrupted or injected server timestamp that is days away.
 */
const MAX_SERVER_TIME_CLIENT_DRIFT_MS = 24 * 60 * 60 * 1_000;

interface DigestSource {
  digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
}

export interface BankApiErrorDetails {
  readonly availableMinor?: Money;
  readonly requiredMinor?: Money;
  readonly retryAfterSeconds?: number;
}

export class TelegramApiRequestError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  readonly code: string;
  readonly details?: BankApiErrorDetails;

  constructor(
    status: number,
    code = 'request_failed',
    details?: BankApiErrorDetails,
  ) {
    super(`Telegram API request failed (${status})`);
    this.name = 'TelegramApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable =
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status >= 500 ||
      (status === 409 && code === 'bank_already_exists');
  }
}

export class TelegramApiResponseError extends TypeError {
  readonly retryable = false;

  constructor() {
    super('Invalid Telegram API response');
    this.name = 'TelegramApiResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeDisplayName(value: string): string | null {
  if (DISALLOWED_DISPLAY_NAME_CHARACTERS.test(value)) return null;
  const normalized = value
    .normalize('NFC')
    .replace(UNICODE_SEPARATORS, ' ')
    .trim();
  if (normalized === '' || [...normalized].length > MAX_DISPLAY_NAME_CODE_POINTS) return null;
  return normalized;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseTrustedServerTime(value: unknown, clientNowISO: string): string {
  if (
    !isIsoTimestamp(value) ||
    !isIsoTimestamp(clientNowISO) ||
    // Server payloads use one canonical UTC representation. Reject equivalent
    // offsets and variable precision so the contract stays unambiguous.
    new Date(value).toISOString() !== value ||
    new Date(clientNowISO).toISOString() !== clientNowISO
  ) {
    throw new TelegramApiResponseError();
  }
  const drift = Math.abs(Date.parse(value) - Date.parse(clientNowISO));
  if (drift > MAX_SERVER_TIME_CLIENT_DRIFT_MS) throw new TelegramApiResponseError();
  return value;
}

function parseErrorDetails(value: unknown): BankApiErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const availableMinor = value.availableMinor;
  const requiredMinor = value.requiredMinor;
  const retryAfterSeconds = value.retryAfterSeconds;
  if (
    availableMinor !== undefined && !isSafeNonNegativeInteger(availableMinor) ||
    requiredMinor !== undefined && !isSafeNonNegativeInteger(requiredMinor) ||
    retryAfterSeconds !== undefined && !isSafeNonNegativeInteger(retryAfterSeconds)
  ) {
    return undefined;
  }
  return {
    ...(availableMinor === undefined ? {} : { availableMinor }),
    ...(requiredMinor === undefined ? {} : { requiredMinor }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

export async function parseTelegramApiError(response: Response): Promise<TelegramApiRequestError> {
  let code = 'request_failed';
  let details: BankApiErrorDetails | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === 'string' && ERROR_CODE_PATTERN.test(body.error)) {
      code = body.error;
      details = parseErrorDetails(body.details);
    }
  } catch {
    // The status remains authoritative when an edge returns HTML or an empty body.
  }
  return new TelegramApiRequestError(response.status, code, details);
}

function parseWarning(value: unknown): ServerBankWarning | null {
  if (!isRecord(value) || typeof value.ruleId !== 'string' || value.ruleId.length === 0) return null;
  const reason = value.reason;
  if (
    typeof reason !== 'string' ||
    !(WARNING_REASONS as readonly string[]).includes(reason) ||
    value.availableMinor !== undefined && !isSafeNonNegativeInteger(value.availableMinor) ||
    value.requiredMinor !== undefined && !isSafeNonNegativeInteger(value.requiredMinor)
  ) {
    return null;
  }
  return {
    ruleId: value.ruleId,
    reason: reason as ServerBankWarning['reason'],
    ...(value.availableMinor === undefined ? {} : { availableMinor: value.availableMinor as number }),
    ...(value.requiredMinor === undefined ? {} : { requiredMinor: value.requiredMinor as number }),
  };
}

function parseWarnings(value: unknown): readonly ServerBankWarning[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const warnings = value.map(parseWarning);
  return warnings.every((warning) => warning !== null)
    ? warnings as ServerBankWarning[]
    : null;
}

export function parseLaunchPreferences(value: unknown): LaunchPreferences {
  if (!isRecord(value)) throw new TelegramApiResponseError();
  const displayName = value.displayName;
  const telegramId = value.telegramId;
  const revisionEpoch = value.revisionEpoch;
  const revision = value.revision;
  const primaryCurrency = value.primaryCurrency;
  const normalizedDisplayName =
    typeof displayName === 'string' ? normalizeDisplayName(displayName) : null;
  const validCurrency =
    typeof primaryCurrency === 'string' &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(primaryCurrency);
  if (
    value.version !== 1 ||
    typeof revisionEpoch !== 'string' ||
    !REVISION_EPOCH_PATTERN.test(revisionEpoch) ||
    !isSafePositiveInteger(revision) ||
    !isAppLocale(value.locale) ||
    !validCurrency ||
    typeof displayName !== 'string' ||
    normalizedDisplayName !== displayName ||
    typeof telegramId !== 'string' ||
    !TELEGRAM_ID_PATTERN.test(telegramId)
  ) {
    throw new TelegramApiResponseError();
  }
  return {
    version: 1,
    revisionEpoch,
    revision,
    locale: value.locale,
    primaryCurrency: primaryCurrency as LaunchPreferences['primaryCurrency'],
    displayName,
    telegramId,
  };
}

function parseServerRevision(
  value: Record<string, unknown>,
  expectedTelegramId: string,
  trustedServerTime: string,
): ServerBankRevision {
  const telegramId = value.telegramId;
  const revisionEpoch = value.revisionEpoch;
  const revision = value.revision;
  const digest = value.digest;
  const warnings = parseWarnings(value.warnings);
  if (
    value.contractVersion !== 1 ||
    value.mode !== 'server' ||
    telegramId !== expectedTelegramId ||
    typeof revisionEpoch !== 'string' ||
    !REVISION_EPOCH_PATTERN.test(revisionEpoch) ||
    !isSafePositiveInteger(revision) ||
    typeof digest !== 'string' ||
    !STATE_DIGEST_PATTERN.test(digest) ||
    warnings === null
  ) {
    throw new TelegramApiResponseError();
  }
  const state = parseBankState(value.state, trustedServerTime, { expectedTelegramId });
  if (state === null) throw new TelegramApiResponseError();
  return { telegramId, revisionEpoch, revision, digest, state, warnings };
}

export function parseLaunchState(value: unknown, clientNowISO: string): LaunchState {
  const preferences = parseLaunchPreferences(value);
  if (!isRecord(value)) throw new TelegramApiResponseError();
  const rawBank = value.bank;
  if (rawBank === undefined) return preferences;
  if (!isRecord(rawBank) || rawBank.contractVersion !== 1) {
    throw new TelegramApiResponseError();
  }
  if (rawBank.mode === 'import_required') {
    if (rawBank.telegramId !== preferences.telegramId) throw new TelegramApiResponseError();
    return {
      ...preferences,
      bank: {
        contractVersion: 1,
        mode: 'import_required',
        telegramId: preferences.telegramId,
      },
    };
  }
  if (rawBank.mode !== 'server') throw new TelegramApiResponseError();
  const serverTime = parseTrustedServerTime(rawBank.serverTime, clientNowISO);
  return {
    ...preferences,
    bank: {
      contractVersion: 1,
      mode: 'server',
      ...parseServerRevision(rawBank, preferences.telegramId, serverTime),
    },
  };
}

function parseSuccessfulOutcome(
  value: unknown,
  state: BankState,
  applied: boolean,
  warnings: readonly ServerBankWarning[],
): SuccessfulBankCommandOutcome {
  if (!isRecord(value) || value.ok !== true || value.applied !== applied) {
    throw new TelegramApiResponseError();
  }
  const incomingAmountMinor = value.incomingAmountMinor;
  const backfilled = value.backfilled;
  if (
    incomingAmountMinor !== undefined && !isSafePositiveInteger(incomingAmountMinor) ||
    backfilled !== undefined && !isSafeNonNegativeInteger(backfilled)
  ) {
    throw new TelegramApiResponseError();
  }
  return {
    ok: true,
    state,
    applied,
    warnings: [...warnings],
    ...(incomingAmountMinor === undefined ? {} : { incomingAmountMinor }),
    ...(backfilled === undefined ? {} : { backfilled }),
  } as Extract<BankCommandOutcome, { readonly ok: true }>;
}

export function parseBankImportResponse(
  value: unknown,
  expectedTelegramId: string,
  clientNowISO: string,
): BankImportResponse {
  if (!isRecord(value) || value.version !== 1 || value.mode !== 'server' || typeof value.imported !== 'boolean') {
    throw new TelegramApiResponseError();
  }
  const serverTime = parseTrustedServerTime(value.serverTime, clientNowISO);
  return {
    version: 1,
    mode: 'server',
    imported: value.imported,
    ...parseServerRevision(value, expectedTelegramId, serverTime),
  };
}

export function parseBankCommandResponse(
  value: unknown,
  expectedTelegramId: string,
  clientNowISO: string,
): BankCommandResponse {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.applied !== 'boolean' ||
    typeof value.replayed !== 'boolean'
  ) {
    throw new TelegramApiResponseError();
  }
  const serverTime = parseTrustedServerTime(value.serverTime, clientNowISO);
  const revision = parseServerRevision(value, expectedTelegramId, serverTime);
  return {
    version: 1,
    applied: value.applied,
    replayed: value.replayed,
    ...revision,
    outcome: parseSuccessfulOutcome(value.outcome, revision.state, value.applied, revision.warnings),
  };
}

export function parseBankRatesRefreshResponse(
  value: unknown,
  expectedTelegramId: string,
  clientNowISO: string,
): BankRatesRefreshResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.updated !== 'boolean') {
    throw new TelegramApiResponseError();
  }
  const serverTime = parseTrustedServerTime(value.serverTime, clientNowISO);
  return {
    version: 1,
    updated: value.updated,
    ...parseServerRevision(value, expectedTelegramId, serverTime),
  };
}

export async function assertServerRevisionDigest(
  revision: ServerBankRevision,
  digestSource: DigestSource | undefined = globalThis.crypto?.subtle,
): Promise<void> {
  if (digestSource === undefined) throw new TelegramApiResponseError();
  const bytes = new TextEncoder().encode(canonicalBankStateJson(revision.state));
  const digest = await digestSource.digest('SHA-256', bytes);
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (encoded !== revision.digest) throw new TelegramApiResponseError();
}
