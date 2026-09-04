import { CURRENCY_METADATA } from '@/domain/currency';
import type { Currency } from '@/domain/types';

interface CurrencyBadgeProps {
  currency: Currency;
  size?: number;
  className?: string;
}

/** Generated guilloche artwork with a real text symbol layered above it. */
export function CurrencyBadge({ currency, size = 40, className = '' }: CurrencyBadgeProps) {
  const meta = CURRENCY_METADATA[currency];
  const symbolSize = meta.symbol.length > 1 ? size * 0.26 : size * 0.34;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink/10 bg-surface-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.025)] ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
        src={`/assets/currencies/${meta.assetSlug}.png`}
      />
      <span
        className="num relative flex size-[58%] items-center justify-center rounded-full bg-bg/55 font-semibold text-ivory shadow-[0_1px_8px_rgba(0,0,0,0.35)] backdrop-blur-[2px]"
        style={{ fontSize: symbolSize }}
      >
        {meta.symbol}
      </span>
    </span>
  );
}
