import type { Money } from './types';

/** Single config point for the demo currency (docs/spec.md §8). */
export const CURRENCY = 'RUB';
export const LOCALE = 'ru-RU';

const currencyFmt = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const wholeFmt = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Typographic minus (U+2212) instead of the hyphen-minus Intl emits. */
function typographic(s: string): string {
  return s.replace('-', '−');
}

export function formatMoney(minor: Money): string {
  return typographic(currencyFmt.format(minor / 100));
}

/** Whole rubles, no kopecks — for compact rows. */
export function formatMoneyWhole(minor: Money): string {
  return typographic(wholeFmt.format(Math.trunc(minor / 100)));
}

/** Explicit sign for transaction rows: +1 500 ₽ / −340 ₽. */
export function formatSigned(minor: Money): string {
  const abs = formatMoney(Math.abs(minor));
  return minor >= 0 ? `+${abs}` : `−${abs}`;
}

export function rub(major: number): Money {
  return Math.round(major * 100);
}

/**
 * Parse user amount input: "1 500", "1500,50", "1500.5" → minor units.
 * Returns null when not a valid positive amount.
 */
export function parseAmountInput(raw: string): Money | null {
  const cleaned = raw.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const minor = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}
