import { CURRENCY_METADATA } from './currency';
import type { Currency, ExchangeRateSnapshot, Money } from './types';

/**
 * One user command may move at most USD 100,000 at the command's frozen rate.
 * Together with the 5,000-row state cap and the fixture's 14% APY, this keeps
 * ten years of IDR-denominated savings settlement inside safe-integer range.
 */
export const MAX_COMMAND_USD_MINOR: Money = 10_000_000;

interface DecimalFraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function positiveDecimal(value: string): DecimalFraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new TypeError('Invalid USD-base exchange rate');
  const fraction = match[2] ?? '';
  const numerator = BigInt(`${match[1]}${fraction}`);
  if (numerator <= 0n) throw new RangeError('USD-base exchange rate must be positive');
  return {
    numerator,
    denominator: 10n ** BigInt(fraction.length),
  };
}

/** Compare an arbitrary-size positive minor-unit magnitude without rounding or Number arithmetic. */
export function isWithinCommandUsdLimit(
  amountMinor: bigint,
  currency: Currency,
  snapshot: ExchangeRateSnapshot,
): boolean {
  if (amountMinor < 0n) throw new RangeError('Command amount magnitude must not be negative');
  const rate = positiveDecimal(snapshot.rates[currency]);
  const sourceScale = 10n ** BigInt(CURRENCY_METADATA[currency].minorUnits);
  const usdScale = 10n ** BigInt(CURRENCY_METADATA.USD.minorUnits);

  // amount/sourceScale/rate <= limit/usdScale, cross-multiplied exactly.
  return (
    amountMinor * usdScale * rate.denominator <=
    BigInt(MAX_COMMAND_USD_MINOR) * sourceScale * rate.numerator
  );
}
