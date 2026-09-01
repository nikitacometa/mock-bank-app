import type { Transaction } from '@/domain/types';
import { formatSigned } from '@/domain/money';
import { CategoryIcon } from './icons';
import { CATEGORY_LABELS, fmtTime } from './format';

export function TxRow({ tx, onClick }: { tx: Transaction; onClick?: () => void }) {
  const income = tx.amountMinor > 0;
  const label = CATEGORY_LABELS[tx.category ?? 'other'] ?? 'Другое';
  return (
    <button
      className="flex w-full items-center gap-3.5 rounded-xl px-1 py-2.5 text-left transition-colors active:bg-surface"
      onClick={onClick}
      disabled={!onClick}
    >
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-full ${
          tx.kind === 'interest' ? 'bg-mint-dim text-mint' : 'bg-surface-2 text-ink-2'
        }`}
      >
        <CategoryIcon category={tx.category} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] leading-tight">{tx.counterparty}</span>
        <span className="mt-0.5 block text-[0.8125rem] text-ink-3">
          {label} · {fmtTime(tx.createdAt)}
        </span>
      </span>
      <span className={`num text-[0.9375rem] ${income ? 'text-mint' : 'text-ink'}`}>
        {formatSigned(tx.amountMinor)}
      </span>
    </button>
  );
}
