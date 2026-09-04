import { describe, expect, it } from 'vitest';
import type { Currency } from './types';
import {
  formatMoney,
  formatMoneyDelta,
  formatMoneyParts,
  formatMoneyShortfall,
  formatMoneyWhole,
  formatSigned,
  parseAmountInput,
  rub,
} from './money';

describe('formatMoney', () => {
  it.each<[Currency, string]>([
    ['USD', '12\u202F345,67\u202F$'],
    ['EUR', '12\u202F345,67\u202F€'],
    ['RUB', '12\u202F345,67\u202F₽'],
    ['KZT', '12\u202F345,67\u202F₸'],
    ['THB', '12\u202F345,67\u202F฿'],
    ['VND', '1\u202F234\u202F567\u202F₫'],
    ['IDR', '12\u202F345\u202FRp'],
    ['GEL', '12\u202F345,67\u202F₾'],
  ])('formats %s with its ISO minor units and symbol', (currency, expected) => {
    expect(formatMoney(1_234_567, currency)).toBe(expected);
  });

  it('uses RUB as the backward-compatible default', () => {
    expect(formatMoney(rub(12_450.5))).toBe('12\u202F450,50\u202F₽');
  });

  it('uses typographic minus, never hyphen', () => {
    const s = formatSigned(-rub(340));
    expect(s.startsWith('−')).toBe(true);
    expect(s).not.toContain('-');
  });

  it('prefixes plus for income', () => {
    expect(formatSigned(rub(1_500)).startsWith('+')).toBe(true);
  });

  it('truncates compact values to whole major units', () => {
    expect(formatMoneyWhole(-123_456, 'EUR')).toBe('−1\u202F234\u202F€');
  });

  it('rejects non-integer money at the formatting boundary', () => {
    expect(() => formatMoney(10.5, 'USD')).toThrowError(RangeError);
  });

  it('keeps hidden IDR minor units spendable and rounds a shortfall up visibly', () => {
    expect(formatMoney(1_234_567, 'IDR')).toBe('12\u202F345\u202FRp');
    expect(formatMoneyShortfall(33, 'IDR')).toBe('1\u202FRp');
  });

  it('shows a non-zero hidden IDR delta instead of zero', () => {
    expect(formatMoneyDelta(33, 'IDR')).toBe('<1\u202FRp');
    expect(formatSigned(33, 'IDR')).toBe('+<1\u202FRp');
    expect(formatSigned(-33, 'IDR')).toBe('−<1\u202FRp');
  });

  it.each<[Currency, string]>([
    ['USD', '$12,345.67'],
    ['EUR', '€12,345.67'],
    ['RUB', '₽12,345.67'],
    ['KZT', '₸12,345.67'],
    ['THB', '฿12,345.67'],
    ['VND', '₫1,234,567'],
    ['IDR', 'Rp12,345'],
    ['GEL', '₾12,345.67'],
  ])('formats %s with English separators and a leading symbol', (currency, expected) => {
    expect(formatMoney(1_234_567, currency, 'en')).toBe(expected);
  });

  it('keeps English signs and hidden IDR deltas unambiguous', () => {
    expect(formatMoneyWhole(-123_456, 'EUR', 'en')).toBe('−€1,234');
    expect(formatMoneyShortfall(33, 'IDR', 'en')).toBe('Rp1');
    expect(formatMoneyDelta(33, 'IDR', 'en')).toBe('<Rp1');
    expect(formatSigned(-33, 'IDR', 'en')).toBe('−<Rp1');
  });

  it('exposes locale-aware parts without reparsing the formatted hero amount', () => {
    expect(formatMoneyParts(-123_456, 'USD', 'en')).toEqual({
      sign: '−',
      whole: '1,234',
      fraction: '56',
      decimalSeparator: '.',
      symbol: '$',
      symbolFirst: true,
    });
    expect(formatMoneyParts(123_456, 'KZT', 'ru')).toMatchObject({
      whole: '1\u202F234',
      decimalSeparator: ',',
      symbolFirst: false,
    });
  });
});

describe('parseAmountInput', () => {
  it.each([
    ['1500', rub(1500)],
    ['1 500', rub(1500)],
    ['1500,50', rub(1500.5)],
    ['1500.5', rub(1500.5)],
    ['0,01', 1],
  ])('parses %s', (raw, expected) => {
    expect(parseAmountInput(raw)).toBe(expected);
  });

  it.each<Currency>(['USD', 'EUR', 'RUB', 'KZT', 'THB', 'GEL'])(
    'parses two decimal minor units for %s',
    (currency) => {
      expect(parseAmountInput('1\u202F234,56', currency)).toBe(123_456);
    },
  );

  it('parses integer VND amounts and rejects decimal VND input', () => {
    expect(parseAmountInput('1\u202F234', 'VND')).toBe(1_234);
    expect(parseAmountInput('1234,0', 'VND')).toBeNull();
    expect(parseAmountInput('1234.5', 'VND')).toBeNull();
  });

  it('stores IDR in ISO minor units while accepting whole-rupiah input', () => {
    expect(parseAmountInput('1\u202F234', 'IDR')).toBe(123_400);
    expect(parseAmountInput('1234,5', 'IDR')).toBeNull();
  });

  it('parses English decimal and grouped amount input without reinterpreting commas', () => {
    expect(parseAmountInput('1,234.56', 'USD', 'en')).toBe(123_456);
    expect(parseAmountInput('1234.56', 'USD', 'en')).toBe(123_456);
    expect(parseAmountInput('1,234', 'VND', 'en')).toBe(1_234);
    expect(parseAmountInput('12,34.56', 'USD', 'en')).toBeNull();
    expect(parseAmountInput('1,234', 'USD', 'en')).toBe(123_400);
  });

  it.each([['0'], ['-5'], ['abc'], ['1,234'], [''], ['12,345.67']])('rejects %s', (raw) => {
    expect(parseAmountInput(raw)).toBeNull();
  });

  it('rejects a parsed value outside the safe integer range', () => {
    expect(parseAmountInput('90071992547409,92', 'USD')).toBeNull();
  });
});

describe('rub', () => {
  it('keeps zero and exact kopecks integer-safe', () => {
    expect(rub(0)).toBe(0);
    expect(rub(-12.34)).toBe(-1_234);
  });

  it('rejects precision that cannot be represented as kopecks', () => {
    expect(() => rub(1.005)).toThrowError(RangeError);
  });
});
