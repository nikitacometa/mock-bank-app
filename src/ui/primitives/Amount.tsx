import { formatMoney } from '@/domain/money';
import type { Money } from '@/domain/types';
import { useCountUp } from './useCountUp';

/**
 * Hero money value: whole part large, kopecks + ₽ dimmed, mono/tabular,
 * count-up on change.
 */
export function HeroAmount({ minor }: { minor: Money }) {
  const animated = useCountUp(minor);
  const formatted = formatMoney(animated); // "1 234 567,89 ₽"
  const commaAt = formatted.lastIndexOf(',');
  const whole = commaAt === -1 ? formatted : formatted.slice(0, commaAt);
  const rest = commaAt === -1 ? '' : formatted.slice(commaAt);
  return (
    <div className="num text-[2.5rem] leading-none font-medium tracking-tight">
      {whole}
      <span className="text-[1.375rem] text-ink-3">{rest}</span>
    </div>
  );
}
