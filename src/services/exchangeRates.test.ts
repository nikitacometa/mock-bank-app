import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExchangeRateServiceError,
  FRANKFURTER_RATES_URL,
  fetchExchangeRates,
  type ExchangeRateFetch,
} from './exchangeRates';

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
});
