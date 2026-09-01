import { describe, expect, it } from 'vitest';
import { formatMoney, formatSigned, parseAmountInput, rub } from './money';

describe('formatMoney', () => {
  it('formats RU style with narrow spaces and kopecks', () => {
    const s = formatMoney(rub(12_450.5));
    expect(s).toContain('12');
    expect(s).toContain('450,50');
    expect(s).toContain('₽');
  });
  it('uses typographic minus, never hyphen', () => {
    const s = formatSigned(-rub(340));
    expect(s.startsWith('−')).toBe(true);
    expect(s).not.toContain('-');
  });
  it('prefixes plus for income', () => {
    expect(formatSigned(rub(1_500)).startsWith('+')).toBe(true);
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
  it.each([['0'], ['-5'], ['abc'], ['1,234'], [''], ['12,345.67']])('rejects %s', (raw) => {
    expect(parseAmountInput(raw)).toBeNull();
  });
});
