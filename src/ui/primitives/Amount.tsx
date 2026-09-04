import type { ReactNode } from 'react';
import { formatMoneyParts } from '@/domain/money';
import type { Currency, Money } from '@/domain/types';
import { useI18n } from '@/i18n';
import { useCountUp } from './useCountUp';

/**
 * Hero money value: whole part large, kopecks + ₽ dimmed, mono/tabular,
 * count-up on change.
 */
export function HeroAmount({
  minor,
  currency,
  paused = false,
  children,
}: {
  minor: Money;
  currency: Currency;
  paused?: boolean;
  children?: (displayedMinor: Money) => ReactNode;
}) {
  const { locale } = useI18n();
  const animated = useCountUp(minor, 640, paused);
  const parts = formatMoneyParts(animated, currency, locale);
  const fraction = parts.fraction === '' ? '' : `${parts.decimalSeparator}${parts.fraction}`;
  const numeric = `${parts.sign}${parts.whole}${fraction}`;
  const sizeClass =
    numeric.length >= 17
      ? 'text-[1.375rem]'
      : numeric.length >= 14
        ? 'text-[1.75rem]'
        : numeric.length >= 11
          ? 'text-[2rem]'
          : 'text-[2.5rem]';
  return (
    <>
      <div
        className={`num flex min-w-0 flex-wrap items-baseline gap-x-1.5 leading-none font-medium tracking-tight ${sizeClass}`}
      >
        <span className="min-w-0 whitespace-nowrap">
          {parts.symbolFirst && (
            <span className="mr-1.5 text-[1.375rem] text-ink-3">
              {parts.sign}
              {parts.symbol}
            </span>
          )}
          {!parts.symbolFirst && parts.sign}
          {parts.whole}
          {fraction && <span className="text-[1.375rem] text-ink-3">{fraction}</span>}
        </span>
        {!parts.symbolFirst && (
          <span className="text-[1.375rem] text-ink-3">{parts.symbol}</span>
        )}
      </div>
      {children?.(animated)}
    </>
  );
}
