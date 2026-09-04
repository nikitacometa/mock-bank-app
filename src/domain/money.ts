import { CURRENCY_METADATA } from './currency';
import type { Currency, Money } from './types';

/** Backward-compatible default while screens migrate to account currencies. */
export const CURRENCY: Currency = 'RUB';
export type MoneyLocale = 'ru' | 'en';

const NARROW_NO_BREAK_SPACE = '\u202F';
const TYPOGRAPHIC_MINUS = '−';

function assertMoney(minor: Money): void {
  if (!Number.isSafeInteger(minor)) throw new RangeError('Money must be a safe integer');
}

function groupThousands(whole: bigint, locale: MoneyLocale): string {
  const separator = locale === 'ru' ? NARROW_NO_BREAK_SPACE : ',';
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function moneyParts(
  minor: Money,
  currency: Currency,
  locale: MoneyLocale,
  roundHiddenUp = false,
): {
  sign: string;
  whole: string;
  fraction: string;
} {
  assertMoney(minor);
  const { minorUnits, displayDigits } = CURRENCY_METADATA[currency];
  const hiddenMinorScale = 10n ** BigInt(minorUnits - displayDigits);
  const displayScale = 10n ** BigInt(displayDigits);
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const displayValue = hiddenMinorScale === 1n
    ? absolute
    : roundHiddenUp
      ? (absolute + hiddenMinorScale - 1n) / hiddenMinorScale
      : absolute / hiddenMinorScale;
  return {
    sign: value < 0n ? TYPOGRAPHIC_MINUS : '',
    whole: groupThousands(displayValue / displayScale, locale),
    fraction: displayDigits === 0
      ? ''
      : (displayValue % displayScale).toString().padStart(displayDigits, '0'),
  };
}

export interface FormattedMoneyParts {
  readonly sign: string;
  readonly whole: string;
  readonly fraction: string;
  readonly decimalSeparator: ',' | '.';
  readonly symbol: string;
  readonly symbolFirst: boolean;
}

/** Structured display pieces for hero typography without reparsing a formatted string. */
export function formatMoneyParts(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): FormattedMoneyParts {
  const { sign, whole, fraction } = moneyParts(minor, currency, locale);
  return {
    sign,
    whole,
    fraction,
    decimalSeparator: locale === 'ru' ? ',' : '.',
    symbol: CURRENCY_METADATA[currency].symbol,
    symbolFirst: locale === 'en',
  };
}

function joinMoney(
  parts: ReturnType<typeof moneyParts>,
  currency: Currency,
  locale: MoneyLocale,
): string {
  const decimalSeparator = locale === 'ru' ? ',' : '.';
  const decimal = parts.fraction === ''
    ? parts.whole
    : `${parts.whole}${decimalSeparator}${parts.fraction}`;
  const symbol = CURRENCY_METADATA[currency].symbol;
  return locale === 'ru'
    ? `${parts.sign}${decimal}${NARROW_NO_BREAK_SPACE}${symbol}`
    : `${parts.sign}${symbol}${decimal}`;
}

/** Deterministic locale-aware amount with ISO currency precision. */
export function formatMoney(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): string {
  return joinMoney(formatMoneyParts(minor, currency, locale), currency, locale);
}

/** Round a positive shortfall up to the smallest visible currency unit. */
export function formatMoneyShortfall(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): string {
  if (minor <= 0) throw new RangeError('Shortfall must be positive');
  return joinMoney(moneyParts(minor, currency, locale, true), currency, locale);
}

/** Preserve a non-zero delta that is smaller than the currency's visible unit. */
export function formatMoneyDelta(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): string {
  assertMoney(minor);
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const { minorUnits, displayDigits, symbol } = CURRENCY_METADATA[currency];
  const visibleUnit = 10n ** BigInt(minorUnits - displayDigits);
  if (absolute > 0n && absolute < visibleUnit) {
    const sign = value < 0n ? TYPOGRAPHIC_MINUS : '';
    return locale === 'ru'
      ? `${sign}<1${NARROW_NO_BREAK_SPACE}${symbol}`
      : `${sign}<${symbol}1`;
  }
  return formatMoney(minor, currency, locale);
}

/** Compact amount truncated to whole major units. */
export function formatMoneyWhole(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): string {
  assertMoney(minor);
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(CURRENCY_METADATA[currency].minorUnits);
  const whole = groupThousands(absolute / scale, locale);
  const sign = value < 0n ? TYPOGRAPHIC_MINUS : '';
  const symbol = CURRENCY_METADATA[currency].symbol;
  return locale === 'ru'
    ? `${sign}${whole}${NARROW_NO_BREAK_SPACE}${symbol}`
    : `${sign}${symbol}${whole}`;
}

/** Explicit sign for transaction rows: +1 500 ₽ / −340 ₽. */
export function formatSigned(
  minor: Money,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): string {
  assertMoney(minor);
  const absolute = minor < 0 ? -minor : minor;
  return `${minor >= 0 ? '+' : TYPOGRAPHIC_MINUS}${formatMoneyDelta(absolute, currency, locale)}`;
}

function normalizeDecimalInput(
  raw: string,
  displayDigits: number,
  locale: MoneyLocale,
): string | null {
  const compact = raw.replace(/[\s\u00A0\u202F]/g, '');
  if (locale === 'ru') return compact.replace(',', '.');

  const fraction = displayDigits === 0 ? '' : `(?:\\.\\d{1,${displayDigits}})?`;
  const grouped = new RegExp(`^\\d{1,3}(?:,\\d{3})*${fraction}$`);
  const plain = new RegExp(`^\\d+${fraction}$`);
  if (!grouped.test(compact) && !plain.test(compact)) return null;
  return compact.replaceAll(',', '');
}

function parseDecimalToMinor(
  raw: string,
  currency: Currency,
  allowZero = false,
  locale: MoneyLocale = 'ru',
): Money | null {
  const { minorUnits, displayDigits } = CURRENCY_METADATA[currency];
  const cleaned = normalizeDecimalInput(raw, displayDigits, locale);
  if (cleaned === null) return null;
  const pattern = displayDigits === 0
    ? /^(\d+)$/
    : new RegExp(`^(\\d+)(?:\\.(\\d{1,${displayDigits}}))?$`);
  const match = pattern.exec(cleaned);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(displayDigits, '0');
  const displayValue = whole * 10n ** BigInt(displayDigits) + BigInt(fraction || '0');
  const minor = displayValue * 10n ** BigInt(minorUnits - displayDigits);
  if ((!allowZero && minor <= 0n) || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/**
 * Legacy exact RUB helper used by the deterministic seed and domain tests.
 * New user input should stay a string and go through `parseAmountInput`.
 */
export function rub(major: number): Money {
  if (!Number.isFinite(major)) throw new RangeError('Ruble amount must be finite');
  const negative = major < 0;
  const parsed = parseDecimalToMinor((negative ? -major : major).toString(), 'RUB', true);
  if (parsed === null) throw new RangeError('Ruble amount must have at most two decimal places');
  return negative ? -parsed : parsed;
}

/**
 * Parse positive user input into integer minor units. Decimal precision is
 * currency-specific, so zero-display-digit currencies reject decimals.
 */
export function parseAmountInput(
  raw: string,
  currency: Currency = CURRENCY,
  locale: MoneyLocale = 'ru',
): Money | null {
  return parseDecimalToMinor(raw, currency, false, locale);
}
