import { formatMoney } from '@/domain/money';
import type { Currency, ExchangeRateSource, Money } from '@/domain/types';
import { useI18n } from '@/i18n';
import { fmtRateDate } from './format';

export function UsdEquivalent({
  amountMinor,
  sourceCurrency,
  rateSource,
  asOf,
}: {
  amountMinor: Money | null;
  sourceCurrency: Currency;
  rateSource: ExchangeRateSource;
  asOf: string;
}) {
  const { locale, t } = useI18n();
  if (amountMinor === null || sourceCurrency === 'USD') return null;

  const isLive = rateSource === 'frankfurter';
  const rateLabel = isLive
    ? t('usd.liveRate', { date: fmtRateDate(asOf, locale) })
    : t('usd.demoRate');

  return (
    <div className="mt-4 min-w-0 rounded-btn border border-line/70 bg-bg/40 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span
          className="flex min-w-0 items-center gap-2"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-rate-status={isLive ? 'live' : 'fallback'}
        >
          <span className="num shrink-0 rounded-[0.375rem] border border-line bg-surface-2 px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-[0.08em] text-ink-2">
            USD
          </span>
          <span
            className={
              isLive
                ? 'size-1.5 shrink-0 rounded-full bg-mint'
                : 'size-1.5 shrink-0 rounded-full border border-ink-3'
            }
            aria-hidden="true"
          />
          <span className="truncate text-[0.6875rem] font-medium tracking-[0.01em] text-ink-3">
            {rateLabel}
          </span>
        </span>
        <span className="num ml-auto flex shrink-0 items-baseline gap-1 whitespace-nowrap text-right text-ink">
          <span className="text-[0.75rem] font-medium text-ink-3">
            ≈
          </span>
          <span className="text-[1.0625rem] font-semibold tracking-[-0.025em]">
            {formatMoney(amountMinor, 'USD', locale)}
          </span>
        </span>
      </div>
    </div>
  );
}
