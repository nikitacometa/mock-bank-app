import { describe, expect, it } from 'vitest';
import { convertMoney } from './currency';
import { accruedInterest } from './interest';
import { MAX_COMMAND_USD_MINOR, isWithinCommandUsdLimit } from './commandLimits';
import { SEED_RATES_V1 } from './seed';

describe('command money ceiling', () => {
  it('accepts the exact USD ceiling and rejects one KZT tiyn above it without rounding', () => {
    const exactKztMinor = 4_622_700_000n;
    expect(isWithinCommandUsdLimit(exactKztMinor, 'KZT', SEED_RATES_V1)).toBe(true);
    expect(isWithinCommandUsdLimit(exactKztMinor + 1n, 'KZT', SEED_RATES_V1)).toBe(false);
  });

  it('keeps ten years of 14% interest safe at the 5000-row IDR worst case', () => {
    const maximumPrincipal = convertMoney(
      MAX_COMMAND_USD_MINOR * 5_000,
      'USD',
      'IDR',
      SEED_RATES_V1,
    );
    const interest = accruedInterest(
      maximumPrincipal,
      0.14,
      '2026-09-05T00:00:00.000Z',
      '2036-09-05T00:00:00.000Z',
    );

    expect(Number.isSafeInteger(maximumPrincipal + interest)).toBe(true);
  });
});
