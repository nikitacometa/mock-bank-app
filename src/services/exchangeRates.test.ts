import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CachedExchangeRateProvider,
  EXCHANGE_RATE_CACHE_MS,
  EXCHANGE_RATE_RETRY_COOLDOWN_MS,
  ExchangeRateServiceError,
  FRANKFURTER_RATES_URL,
  MAX_EXCHANGE_RATE_RESPONSE_BYTES,
  MAX_EXCHANGE_RATE_ROWS,
  fetchExchangeRates,
  shouldAdoptExchangeRateSnapshot,
  type ExchangeRateFetch,
} from './exchangeRates';
import type { ExchangeRateSnapshot } from '@/domain/types';

const FETCHED_AT = '2026-09-01T12:34:56.000Z';
const AS_OF = '2026-08-31';
const RANGE_START = '2026-08-25';
const EXPECTED_RANGE_URL = `${FRANKFURTER_RATES_URL}&from=${RANGE_START}&to=2026-09-01`;

const VALID_ROWS = [
  { date: AS_OF, base: 'USD', quote: 'EUR', rate: 0.86107 },
  { date: AS_OF, base: 'USD', quote: 'RUB', rate: 86.24 },
  { date: AS_OF, base: 'USD', quote: 'KZT', rate: 462.27 },
  { date: AS_OF, base: 'USD', quote: 'THB', rate: 33.136 },
  { date: AS_OF, base: 'USD', quote: 'VND', rate: 26044 },
  { date: AS_OF, base: 'USD', quote: 'IDR', rate: 17710 },
  { date: AS_OF, base: 'USD', quote: 'GEL', rate: 2.6121 },
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function fixedNow(): Date {
  return new Date(FETCHED_AT);
}

type TestQuote = (typeof VALID_ROWS)[number]['quote'];

function cloneRows(
  date = AS_OF,
  rateOverrides: Partial<Record<TestQuote, unknown>> = {},
): Array<Record<string, unknown>> {
  return VALID_ROWS.map((row) => ({
    ...row,
    date,
    rate: rateOverrides[row.quote] ?? row.rate,
  }));
}

function mockFetch(response: Response): ExchangeRateFetch {
  return vi.fn(async () => response);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchExchangeRates', () => {
  it('returns the exact canonical eight-currency USD snapshot', async () => {
    const fetchImpl = mockFetch(jsonResponse([...VALID_ROWS].reverse()));

    await expect(fetchExchangeRates({ fetchImpl, now: fixedNow })).resolves.toEqual({
      base: 'USD',
      asOf: AS_OF,
      fetchedAt: FETCHED_AT,
      source: 'frankfurter',
      rates: {
        USD: '1',
        EUR: '0.86107',
        RUB: '86.24',
        KZT: '462.27',
        THB: '33.136',
        VND: '26044',
        IDR: '17710',
        GEL: '2.6121',
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(EXPECTED_RANGE_URL, {
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects non-success HTTP responses with status context', async () => {
    const result = fetchExchangeRates({
      fetchImpl: mockFetch(jsonResponse({ error: 'busy' }, 503)),
      now: fixedNow,
    });

    await expect(result).rejects.toMatchObject({ code: 'http', status: 503 });
  });

  it('rejects malformed JSON and malformed row schemas', async () => {
    const invalidJson = fetchExchangeRates({
      fetchImpl: mockFetch(new Response('{', { status: 200 })),
      now: fixedNow,
    });
    await expect(invalidJson).rejects.toMatchObject({ code: 'invalid_payload' });

    const rows = cloneRows();
    delete rows[0]?.rate;
    const invalidSchema = fetchExchangeRates({
      fetchImpl: mockFetch(jsonResponse(rows)),
      now: fixedNow,
    });
    await expect(invalidSchema).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects declared and streamed response bodies above the decoded-byte limit', async () => {
    const declaredOversized = new Response('[]', {
      headers: {
        'Content-Length': String(MAX_EXCHANGE_RATE_RESPONSE_BYTES + 1),
        'Content-Type': 'application/json',
      },
    });
    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(declaredOversized), now: fixedNow }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });

    const firstChunk = new Uint8Array(MAX_EXCHANGE_RATE_RESPONSE_BYTES);
    firstChunk.fill(0x20);
    const streamedOversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
        controller.enqueue(new Uint8Array([0x20]));
        controller.close();
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(streamedOversized), now: fixedNow }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects provider arrays above the row-count limit before schema traversal', async () => {
    const rows = Array.from({ length: MAX_EXCHANGE_RATE_ROWS + 1 }, () => null);

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow(`${MAX_EXCHANGE_RATE_ROWS}-row limit`);
  });

  it('rejects a response with no complete same-date quote set', async () => {
    const rows = cloneRows().filter((row) => row.quote !== 'GEL');

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow('no complete same-date quote set');
  });

  it('rejects duplicate quotes within one observation date', async () => {
    const rows = [...cloneRows(), { ...cloneRows()[0] }];

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow(`duplicate EUR quote for ${AS_OF}`);
  });

  it('rejects a base other than USD', async () => {
    const rows = cloneRows();
    rows[2] = { ...rows[2], base: 'EUR' };

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow('unexpected base');
  });

  it('rejects a quote outside the exact supported set', async () => {
    const rows = cloneRows();
    rows[2] = { ...rows[2], quote: 'GBP' };

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow('unexpected quote');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['string', '86.24'],
    ['non-decimal exponent', 1e-7],
  ])('rejects a %s rate', async (_label, rate) => {
    const rows = cloneRows();
    rows[1] = { ...rows[1], rate };

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects impossible dates', async () => {
    const impossible = cloneRows();
    impossible[0] = { ...impossible[0], date: '2026-02-30' };
    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(impossible)), now: fixedNow }),
    ).rejects.toThrow('invalid date');
  });

  it('uses only the latest complete same-date quote group without cross-date mixing', async () => {
    const olderComplete = cloneRows('2026-08-30', { EUR: 0.81 });
    const latestComplete = cloneRows(AS_OF, { EUR: 0.82 });
    const incompleteToday = cloneRows('2026-09-01', { EUR: 0.99 }).filter(
      (row) => row.quote === 'EUR',
    );

    await expect(
      fetchExchangeRates({
        fetchImpl: mockFetch(
          jsonResponse([...incompleteToday, ...olderComplete, ...latestComplete].reverse()),
        ),
        now: fixedNow,
      }),
    ).resolves.toMatchObject({
      asOf: AS_OF,
      rates: { EUR: '0.82', RUB: '86.24' },
    });
  });

  it('does not assemble a complete quote set from different observation dates', async () => {
    const splitAcrossDates = cloneRows().map((row, index) => ({
      ...row,
      date: index < 3 ? AS_OF : '2026-09-01',
    }));

    await expect(
      fetchExchangeRates({
        fetchImpl: mockFetch(jsonResponse(splitAcrossDates)),
        now: fixedNow,
      }),
    ).rejects.toThrow('no complete same-date quote set');
  });

  it.each([
    ['before', '2026-08-24'],
    ['after', '2026-09-02'],
  ])('rejects rows %s the requested UTC range', async (_position, date) => {
    const rows = cloneRows(date);

    await expect(
      fetchExchangeRates({ fetchImpl: mockFetch(jsonResponse(rows)), now: fixedNow }),
    ).rejects.toThrow('outside the requested UTC range');
  });

  it('builds the inclusive seven-day UTC lookback across a leap-day boundary', async () => {
    const boundaryNow = (): Date => new Date('2024-03-01T00:00:01.000Z');
    const fetchImpl = mockFetch(jsonResponse(cloneRows('2024-02-29')));

    await expect(fetchExchangeRates({ fetchImpl, now: boundaryNow })).resolves.toMatchObject({
      asOf: '2024-02-29',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${FRANKFURTER_RATES_URL}&from=2024-02-23&to=2024-03-01`,
      {
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('wraps network failures without leaking an untyped error', async () => {
    const fetchImpl: ExchangeRateFetch = vi.fn(async () => {
      throw new TypeError('connection reset');
    });

    const result = fetchExchangeRates({ fetchImpl, now: fixedNow });
    await expect(result).rejects.toBeInstanceOf(ExchangeRateServiceError);
    await expect(result).rejects.toMatchObject({ code: 'network' });
  });

  it('aborts and returns a typed timeout when the provider does not settle', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: ExchangeRateFetch = vi.fn((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const request = fetchExchangeRates({ fetchImpl, now: fixedNow, timeoutMs: 50 });
    const assertion = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('keeps the timeout active while the response body is streaming', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('['));
      },
      cancel,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl: ExchangeRateFetch = vi.fn(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return response;
    });

    const request = fetchExchangeRates({ fetchImpl, now: fixedNow, timeoutMs: 50 });
    const assertion = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('server exchange-rate selection', () => {
  function snapshot(
    asOf: string,
    fetchedAt: string,
    source: ExchangeRateSnapshot['source'] = 'frankfurter',
  ): ExchangeRateSnapshot {
    return {
      base: 'USD',
      asOf,
      fetchedAt,
      source,
      rates: {
        USD: '1',
        EUR: '0.86',
        RUB: '86.2',
        KZT: '462.2',
        THB: '33.1',
        VND: '26044',
        IDR: '17710',
        GEL: '2.61',
      },
    };
  }

  it('prefers observation date before fetchedAt and rejects future-clock candidates', () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z');
    const current = snapshot('2026-09-04', '2026-09-05T10:00:00.000Z');

    expect(shouldAdoptExchangeRateSnapshot(
      current,
      snapshot('2026-09-03', '2026-09-05T11:00:00.000Z'),
      now,
    )).toBe(false);
    expect(shouldAdoptExchangeRateSnapshot(
      current,
      snapshot('2026-09-04', '2026-09-05T11:00:00.000Z'),
      now,
    )).toBe(true);
    expect(shouldAdoptExchangeRateSnapshot(
      current,
      snapshot('2026-09-05', '2026-09-05T12:05:01.000Z'),
      now,
    )).toBe(false);
    expect(shouldAdoptExchangeRateSnapshot(
      snapshot('2026-08-28', '2026-08-28T12:00:00.000Z', 'fallback'),
      current,
      now,
    )).toBe(true);
  });

  it('deduplicates concurrent loads and reuses the validated process cache', async () => {
    let resolveLoad: ((value: ExchangeRateSnapshot) => void) | undefined;
    const load = vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
      resolveLoad = resolve;
    }));
    const provider = new CachedExchangeRateProvider(
      load,
      () => Date.parse('2026-09-05T12:00:00.000Z'),
    );
    const expected = snapshot('2026-09-05', '2026-09-05T12:00:00.000Z');

    const first = provider.get();
    const second = provider.get();
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad?.(expected);
    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
    await expect(provider.get()).resolves.toBe(expected);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares a failed-load cooldown across sequential users and retries after expiry', async () => {
    const expected = snapshot('2026-09-05', '2026-09-05T12:00:00.000Z');
    const failure = new ExchangeRateServiceError('network', 'offline');
    const load = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(expected);
    let nowMs = Date.parse('2026-09-05T12:00:00.000Z');
    const provider = new CachedExchangeRateProvider(
      load,
      () => nowMs,
    );

    await expect(provider.get()).rejects.toBe(failure);
    await expect(provider.get()).rejects.toBe(failure);
    nowMs += EXCHANGE_RATE_RETRY_COOLDOWN_MS - 1;
    await expect(provider.get()).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(provider.get()).resolves.toBe(expected);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('returns a stale last-good snapshot during a regressing-candidate cooldown', async () => {
    const initialMs = Date.parse('2026-09-05T00:00:00.000Z');
    let nowMs = initialMs;
    const current = snapshot('2026-09-04', new Date(initialMs).toISOString());
    const regressing = snapshot(
      '2026-09-03',
      new Date(initialMs + EXCHANGE_RATE_CACHE_MS).toISOString(),
    );
    const newer = snapshot(
      '2026-09-05',
      new Date(
        initialMs + EXCHANGE_RATE_CACHE_MS + EXCHANGE_RATE_RETRY_COOLDOWN_MS,
      ).toISOString(),
    );
    const load = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(regressing)
      .mockResolvedValueOnce(newer);
    const provider = new CachedExchangeRateProvider(load, () => nowMs);

    await expect(provider.get()).resolves.toBe(current);
    nowMs += EXCHANGE_RATE_CACHE_MS;
    await expect(provider.get()).resolves.toBe(current);
    await expect(provider.get()).resolves.toBe(current);
    nowMs += EXCHANGE_RATE_RETRY_COOLDOWN_MS - 1;
    await expect(provider.get()).resolves.toBe(current);
    expect(load).toHaveBeenCalledTimes(2);

    nowMs += 1;
    await expect(provider.get()).resolves.toBe(newer);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
