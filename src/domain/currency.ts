import type { Currency, ExchangeRateSnapshot, Money } from './types';

export interface CurrencyMetadata {
  readonly displayName: string;
  readonly symbol: string;
  /** ISO 4217 minor-unit exponent used for ledger storage and FX conversion. */
  readonly minorUnits: number;
  /** CLDR-style fraction digits shown to the user. */
  readonly displayDigits: number;
  readonly assetSlug: string;
}

export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'RUB',
  'KZT',
  'THB',
  'VND',
  'IDR',
  'GEL',
] as const satisfies readonly Currency[];

export const CURRENCY_METADATA = {
  USD: { displayName: 'Доллар США', symbol: '$', minorUnits: 2, displayDigits: 2, assetSlug: 'usd' },
  EUR: { displayName: 'Евро', symbol: '€', minorUnits: 2, displayDigits: 2, assetSlug: 'eur' },
  RUB: { displayName: 'Российский рубль', symbol: '₽', minorUnits: 2, displayDigits: 2, assetSlug: 'rub' },
  KZT: { displayName: 'Казахстанский тенге', symbol: '₸', minorUnits: 2, displayDigits: 2, assetSlug: 'kzt' },
  THB: { displayName: 'Тайский бат', symbol: '฿', minorUnits: 2, displayDigits: 2, assetSlug: 'thb' },
  VND: { displayName: 'Вьетнамский донг', symbol: '₫', minorUnits: 0, displayDigits: 0, assetSlug: 'vnd' },
  IDR: { displayName: 'Индонезийская рупия', symbol: 'Rp', minorUnits: 2, displayDigits: 0, assetSlug: 'idr' },
  GEL: { displayName: 'Грузинский лари', symbol: '₾', minorUnits: 2, displayDigits: 2, assetSlug: 'gel' },
} as const satisfies Readonly<Record<Currency, CurrencyMetadata>>;

export type MoneyRoundingMode = 'half-away-from-zero' | 'toward-zero';

export const FX_RATE_DECIMAL_PLACES = 18;

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function decimalRate(value: string, currency: Currency): Fraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TypeError(`Invalid ${currency} exchange rate`);

  const fractional = match[2] ?? '';
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(`${match[1]}${fractional}`);
  if (numerator <= 0n) throw new RangeError(`${currency} exchange rate must be positive`);

  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function minorUnitScale(currency: Currency): bigint {
  return 10n ** BigInt(CURRENCY_METADATA[currency].minorUnits);
}

function roundRatio(
  numerator: bigint,
  denominator: bigint,
  roundingMode: MoneyRoundingMode,
): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;

  if (roundingMode === 'half-away-from-zero' && remainder * 2n >= denominator) {
    quotient += 1n;
  }

  return negative ? -quotient : quotient;
}

function safeMoneyResult(value: bigint): Money {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Converted amount exceeds the safe integer range');
  }
  return Number(value);
}

/** Convert minor units with a stored target-major/source-major cross-rate. */
export function convertMoneyAtCrossRate(
  amountMinor: Money,
  fromCurrency: Currency,
  toCurrency: Currency,
  crossRate: string,
  roundingMode: MoneyRoundingMode = 'half-away-from-zero',
): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Source amount must be a safe integer');
  }
  if (roundingMode !== 'half-away-from-zero' && roundingMode !== 'toward-zero') {
    throw new TypeError('Unsupported money rounding mode');
  }
  const rate = decimalRate(crossRate, toCurrency);
  const converted = roundRatio(
    BigInt(amountMinor) * rate.numerator * minorUnitScale(toCurrency),
    rate.denominator * minorUnitScale(fromCurrency),
    roundingMode,
  );
  return safeMoneyResult(converted);
}

/** Convert with the two exact USD-base quotes frozen at execution time. */
export function convertMoneyAtBaseRates(
  amountMinor: Money,
  fromCurrency: Currency,
  toCurrency: Currency,
  fromUsdRate: string,
  toUsdRate: string,
  roundingMode: MoneyRoundingMode = 'half-away-from-zero',
): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Source amount must be a safe integer');
  }
  if (roundingMode !== 'half-away-from-zero' && roundingMode !== 'toward-zero') {
    throw new TypeError('Unsupported money rounding mode');
  }
  if (fromCurrency === toCurrency) return amountMinor;

  const fromRate = decimalRate(fromUsdRate, fromCurrency);
  const toRate = decimalRate(toUsdRate, toCurrency);
  const converted = roundRatio(
    BigInt(amountMinor) *
      toRate.numerator *
      fromRate.denominator *
      minorUnitScale(toCurrency),
    toRate.denominator *
      fromRate.numerator *
      minorUnitScale(fromCurrency),
    roundingMode,
  );
  return safeMoneyResult(converted);
}

/** Human-readable target/source quote derived from the same frozen base rates. */
export function quoteCrossRate(
  fromCurrency: Currency,
  toCurrency: Currency,
  fromUsdRate: string,
  toUsdRate: string,
): string {
  const from = decimalRate(fromUsdRate, fromCurrency);
  const to = decimalRate(toUsdRate, toCurrency);
  const numerator = to.numerator * from.denominator;
  const denominator = to.denominator * from.numerator;
  const scale = 10n ** BigInt(FX_RATE_DECIMAL_PLACES);
  let scaled = (numerator * scale) / denominator;
  const remainder = (numerator * scale) % denominator;
  if (remainder * 2n >= denominator) scaled += 1n;

  const padded = scaled.toString().padStart(FX_RATE_DECIMAL_PLACES + 1, '0');
  const integer = padded.slice(0, -FX_RATE_DECIMAL_PLACES);
  const fraction = padded.slice(-FX_RATE_DECIMAL_PLACES).replace(/0+$/, '');
  return fraction === '' ? integer : `${integer}.${fraction}`;
}

/**
 * Convert integer minor units using the immutable USD-based rate snapshot.
 * The default midpoint rule is half away from zero; callers may explicitly
 * request truncation toward zero. No money or rate arithmetic uses Number.
 */
export function convertMoney(
  amountMinor: Money,
  fromCurrency: Currency,
  toCurrency: Currency,
  snapshot: ExchangeRateSnapshot,
  roundingMode: MoneyRoundingMode = 'half-away-from-zero',
): Money {
  return convertMoneyAtBaseRates(
    amountMinor,
    fromCurrency,
    toCurrency,
    snapshot.rates[fromCurrency],
    snapshot.rates[toCurrency],
    roundingMode,
  );
}
