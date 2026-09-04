import { SUPPORTED_CURRENCIES } from '@/domain/currency';
import type { Currency, ExchangeRateSnapshot } from '@/domain/types';

export const FRANKFURTER_RATES_URL =
  'https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,RUB,KZT,THB,VND,IDR,GEL';

export const DEFAULT_EXCHANGE_RATE_TIMEOUT_MS = 8_000;

export type ExchangeRateServiceErrorCode =
  | 'http'
  | 'invalid_payload'
  | 'network'
  | 'timeout';

export class ExchangeRateServiceError extends Error {
  readonly code: ExchangeRateServiceErrorCode;
  readonly status: number | undefined;

  constructor(
    code: ExchangeRateServiceErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExchangeRateServiceError';
    this.code = code;
    this.status = options.status;
  }
}

export type ExchangeRateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchExchangeRatesOptions {
  readonly fetchImpl?: ExchangeRateFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

type QuoteCurrency = Exclude<Currency, 'USD'>;

const EXPECTED_QUOTES = SUPPORTED_CURRENCIES.filter(
  (currency): currency is QuoteCurrency => currency !== 'USD',
);
const EXPECTED_QUOTE_SET = new Set<QuoteCurrency>(EXPECTED_QUOTES);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_PROVIDER_LAG_DAYS = 7;
const DAY_MS = 86_400_000;

function invalidPayload(message: string, cause?: unknown): ExchangeRateServiceError {
  return new ExchangeRateServiceError('invalid_payload', message, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function rateSnapshotLagDays(asOf: string, fetchedAt: string): number | null {
  const fetchedDay = Date.parse(`${fetchedAt.slice(0, 10)}T00:00:00.000Z`);
  const providerDay = Date.parse(`${asOf}T00:00:00.000Z`);
  if (!Number.isFinite(fetchedDay) || !Number.isFinite(providerDay)) return null;
  return (fetchedDay - providerDay) / DAY_MS;
}

function shiftCalendarDateUTC(date: string, days: number): string {
  const epochDay = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(epochDay + days * DAY_MS).toISOString().slice(0, 10);
}

function buildRatesRangeUrl(fetchDay: string): { readonly from: string; readonly url: string } {
  const from = shiftCalendarDateUTC(fetchDay, -MAX_PROVIDER_LAG_DAYS);
  return {
    from,
    url: `${FRANKFURTER_RATES_URL}&from=${from}&to=${fetchDay}`,
  };
}

/** Shared boundary/cache policy: allow weekends and short market holidays, never arbitrary dates. */
export function isRateSnapshotDateCoherent(asOf: string, fetchedAt: string): boolean {
  const lagDays = rateSnapshotLagDays(asOf, fetchedAt);
  return lagDays !== null && lagDays >= 0 && lagDays <= MAX_PROVIDER_LAG_DAYS;
}

function parseRate(value: unknown, quote: QuoteCurrency): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalidPayload(`Frankfurter returned an invalid ${quote} rate`);
  }

  const canonical = String(value);
  if (!DECIMAL_PATTERN.test(canonical)) {
    throw invalidPayload(`Frankfurter returned a non-decimal ${quote} rate`);
  }
  return canonical;
}

function parseSnapshot(
  payload: unknown,
  fetchedAt: string,
  requestedFrom: string,
  requestedTo: string,
): ExchangeRateSnapshot {
  if (!Array.isArray(payload)) {
    throw invalidPayload('Frankfurter payload must be an array');
  }

  const ratesByDate = new Map<string, Map<QuoteCurrency, string>>();

  for (const [index, row] of payload.entries()) {
    if (!isRecord(row)) {
      throw invalidPayload(`Frankfurter row ${index} must be an object`);
    }
    if (row.base !== 'USD') {
      throw invalidPayload(`Frankfurter row ${index} has an unexpected base`);
    }
    if (typeof row.quote !== 'string' || !EXPECTED_QUOTE_SET.has(row.quote as QuoteCurrency)) {
      throw invalidPayload(`Frankfurter row ${index} has an unexpected quote`);
    }
    if (typeof row.date !== 'string' || !isValidCalendarDate(row.date)) {
      throw invalidPayload(`Frankfurter row ${index} has an invalid date`);
    }
    if (row.date < requestedFrom || row.date > requestedTo) {
      throw invalidPayload(`Frankfurter row ${index} is outside the requested UTC range`);
    }

    const quote = row.quote as QuoteCurrency;
    const quoteRates = ratesByDate.get(row.date) ?? new Map<QuoteCurrency, string>();
    if (quoteRates.has(quote)) {
      throw invalidPayload(`Frankfurter returned a duplicate ${quote} quote for ${row.date}`);
    }
    quoteRates.set(quote, parseRate(row.rate, quote));
    ratesByDate.set(row.date, quoteRates);
  }

  let asOf: string | undefined;
  let selectedRates: Map<QuoteCurrency, string> | undefined;
  for (const [date, quoteRates] of ratesByDate) {
    if (quoteRates.size !== EXPECTED_QUOTES.length) continue;
    if (!EXPECTED_QUOTES.every((quote) => quoteRates.has(quote))) continue;
    if (!isRateSnapshotDateCoherent(date, fetchedAt)) continue;
    if (asOf === undefined || date > asOf) {
      asOf = date;
      selectedRates = quoteRates;
    }
  }

  if (asOf === undefined || selectedRates === undefined) {
    throw invalidPayload('Frankfurter response has no complete same-date quote set');
  }

  const requiredRate = (quote: QuoteCurrency): string => {
    const rate = selectedRates.get(quote);
    if (rate === undefined) {
      // Kept as a runtime guard so future edits to the explicit record cannot
      // accidentally weaken the exact-set validation above.
      throw invalidPayload(`Frankfurter response is missing the ${quote} quote`);
    }
    return rate;
  };

  return {
    base: 'USD',
    asOf,
    fetchedAt,
    source: 'frankfurter',
    rates: {
      USD: '1',
      EUR: requiredRate('EUR'),
      RUB: requiredRate('RUB'),
      KZT: requiredRate('KZT'),
      THB: requiredRate('THB'),
      VND: requiredRate('VND'),
      IDR: requiredRate('IDR'),
      GEL: requiredRate('GEL'),
    },
  };
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Exchange-rate timeout must be a positive safe integer');
  }
}

/**
 * Fetch one complete, immutable USD-based reference-rate snapshot.
 * The bounded range may contain incomplete daily groups; only its latest exact
 * same-date quote set is selected, and rates from different dates are never mixed.
 * Fallback policy belongs to the store layer.
 */
export async function fetchExchangeRates(
  options: FetchExchangeRatesOptions = {},
): Promise<ExchangeRateSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_RATE_TIMEOUT_MS;
  validateTimeout(timeoutMs);

  const fetchImpl: ExchangeRateFetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  let fetchDay: string;
  try {
    fetchDay = now().toISOString().slice(0, 10);
  } catch (error: unknown) {
    throw new ExchangeRateServiceError('invalid_payload', 'The injected clock is invalid', {
      cause: error,
    });
  }
  const request = buildRatesRangeUrl(fetchDay);
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ExchangeRateServiceError('timeout', 'Exchange-rate request timed out'));
    }, timeoutMs);
  });

  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(request.url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error: unknown) {
      if (timedOut || (error instanceof ExchangeRateServiceError && error.code === 'timeout')) {
        throw new ExchangeRateServiceError('timeout', 'Exchange-rate request timed out', {
          cause: error,
        });
      }
      throw new ExchangeRateServiceError('network', 'Exchange-rate request failed', {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ExchangeRateServiceError(
        'http',
        `Exchange-rate endpoint returned HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await Promise.race([response.json() as Promise<unknown>, timeout]);
    } catch (error: unknown) {
      if (timedOut || (error instanceof ExchangeRateServiceError && error.code === 'timeout')) {
        throw new ExchangeRateServiceError('timeout', 'Exchange-rate request timed out', {
          cause: error,
        });
      }
      throw invalidPayload('Frankfurter response is not valid JSON', error);
    }

    let fetchedAt: string;
    try {
      fetchedAt = now().toISOString();
    } catch (error: unknown) {
      throw new ExchangeRateServiceError('invalid_payload', 'The injected clock is invalid', {
        cause: error,
      });
    }
    return parseSnapshot(payload, fetchedAt, request.from, fetchDay);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}
