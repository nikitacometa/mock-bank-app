import { describe, expect, it } from 'vitest';
import type { Currency, ExchangeRateSnapshot } from './types';
import {
  CURRENCY_METADATA,
  SUPPORTED_CURRENCIES,
  convertMoney,
  convertMoneyAtBaseRates,
  convertMoneyAtCrossRate,
  quoteCrossRate,
} from './currency';

const SNAPSHOT: ExchangeRateSnapshot = {
  base: 'USD',
  asOf: '2026-09-01',
  fetchedAt: '2026-09-01T08:00:00.000Z',
  source: 'frankfurter',
  rates: {
    USD: '1',
    EUR: '0.85',
    RUB: '90.5',
    KZT: '500',
    THB: '35',
    VND: '25000',
    IDR: '16000',
    GEL: '2.7',
  },
};

describe('currency metadata', () => {
  it('covers exactly the supported currency union', () => {
    expect(SUPPORTED_CURRENCIES).toEqual([
      'USD', 'EUR', 'RUB', 'KZT', 'THB', 'VND', 'IDR', 'GEL',
    ]);
    expect(Object.keys(CURRENCY_METADATA)).toEqual(SUPPORTED_CURRENCIES);
  });

  it.each<[Currency, string, number, number, string]>([
    ['USD', '$', 2, 2, 'Доллар США'],
    ['EUR', '€', 2, 2, 'Евро'],
    ['RUB', '₽', 2, 2, 'Российский рубль'],
    ['KZT', '₸', 2, 2, 'Казахстанский тенге'],
    ['THB', '฿', 2, 2, 'Тайский бат'],
    ['VND', '₫', 0, 0, 'Вьетнамский донг'],
    ['IDR', 'Rp', 2, 0, 'Индонезийская рупия'],
    ['GEL', '₾', 2, 2, 'Грузинский лари'],
  ])('defines %s metadata', (currency, symbol, minorUnits, displayDigits, displayName) => {
    expect(CURRENCY_METADATA[currency]).toEqual({
      displayName,
      symbol,
      minorUnits,
      displayDigits,
      assetSlug: currency.toLowerCase(),
    });
  });
});

describe('convertMoney', () => {
  it('converts a direct USD quote without float arithmetic', () => {
    expect(convertMoney(10_000, 'USD', 'EUR', SNAPSHOT)).toBe(8_500);
  });

  it('converts a cross rate through the shared USD base', () => {
    expect(convertMoney(8_500, 'EUR', 'RUB', SNAPSHOT)).toBe(905_000);
  });

  it('uses the target minor-unit exponent for VND', () => {
    expect(convertMoney(100, 'USD', 'VND', SNAPSHOT)).toBe(25_000);
    expect(convertMoney(25_000, 'VND', 'USD', SNAPSHOT)).toBe(100);
  });

  it('rounds an exact midpoint away from zero', () => {
    const midpoint: ExchangeRateSnapshot = {
      ...SNAPSHOT,
      rates: { ...SNAPSHOT.rates, EUR: '0.5' },
    };
    expect(convertMoney(1, 'USD', 'EUR', midpoint)).toBe(1);
    expect(convertMoney(-1, 'USD', 'EUR', midpoint)).toBe(-1);
    expect(convertMoney(1, 'USD', 'EUR', midpoint, 'toward-zero')).toBe(0);
  });

  it('keeps a forward and reverse conversion within one source minor unit', () => {
    const source = 12_345;
    const converted = convertMoney(source, 'USD', 'RUB', SNAPSHOT);
    const reversed = convertMoney(converted, 'RUB', 'USD', SNAPSHOT);
    expect(Math.abs(reversed - source)).toBeLessThanOrEqual(1);
  });

  it('returns the exact amount for the same currency', () => {
    expect(convertMoney(-12_345, 'GEL', 'GEL', SNAPSHOT)).toBe(-12_345);
  });

  it('rejects unsafe source and converted results', () => {
    expect(() => convertMoney(0.5, 'USD', 'EUR', SNAPSHOT)).toThrowError(
      'Source amount must be a safe integer',
    );
    expect(() => convertMoney(Number.MAX_SAFE_INTEGER, 'USD', 'VND', SNAPSHOT)).toThrowError(
      'Converted amount exceeds the safe integer range',
    );
  });

  it('rejects malformed and non-positive provider rates', () => {
    const malformed: ExchangeRateSnapshot = {
      ...SNAPSHOT,
      rates: { ...SNAPSHOT.rates, EUR: '8.5e-1' },
    };
    const zero: ExchangeRateSnapshot = {
      ...SNAPSHOT,
      rates: { ...SNAPSHOT.rates, EUR: '0' },
    };
    expect(() => convertMoney(100, 'USD', 'EUR', malformed)).toThrowError(TypeError);
    expect(() => convertMoney(100, 'USD', 'EUR', zero)).toThrowError(RangeError);
  });
});

describe('convertMoneyAtCrossRate', () => {
  it('reconstructs a frozen FX amount across different minor-unit exponents', () => {
    expect(convertMoneyAtCrossRate(8_500, 'EUR', 'RUB', '106.470588235294117647')).toBe(
      905_000,
    );
    expect(convertMoneyAtCrossRate(100, 'USD', 'VND', '25000')).toBe(25_000);
  });

  it('uses the same half-away-from-zero midpoint rule as live conversion', () => {
    expect(convertMoneyAtCrossRate(1, 'USD', 'EUR', '0.5')).toBe(1);
    expect(convertMoneyAtCrossRate(-1, 'USD', 'EUR', '0.5')).toBe(-1);
  });
});

describe('frozen base-rate snapshot', () => {
  it('reconstructs a large conversion even when the 18-digit display rate rounds by one minor unit', () => {
    const amount = 969_602_775_000_376;
    const fromUsdRate = '0.86107';
    const toUsdRate = '2.6121';
    const snapshot: ExchangeRateSnapshot = {
      ...SNAPSHOT,
      rates: { ...SNAPSHOT.rates, EUR: fromUsdRate, GEL: toUsdRate },
    };
    const exactConverted = 2_941_339_738_439_944;
    const displayRate = quoteCrossRate('EUR', 'GEL', fromUsdRate, toUsdRate);

    expect(displayRate).toBe('3.033551279222362874');
    expect(convertMoney(amount, 'EUR', 'GEL', snapshot)).toBe(exactConverted);
    expect(convertMoneyAtBaseRates(
      amount,
      'EUR',
      'GEL',
      fromUsdRate,
      toUsdRate,
    )).toBe(exactConverted);
  });
});
