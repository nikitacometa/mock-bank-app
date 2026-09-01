import { useMemo, useState } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import type { Transaction } from '@/domain/types';
import { CATEGORY_LABELS, dayKey, fmtDay } from '../format';
import { TxRow } from '../TxRow';
import { IconSearch } from '../icons';

type Filter = 'all' | 'expense' | 'income';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'expense', label: 'Расходы' },
  { id: 'income', label: 'Поступления' },
];

export function History() {
  const accounts = useBankStore((s) => s.accounts);
  const transactions = useBankStore((s) => s.transactions);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const setActiveAccount = useUiStore((s) => s.setActiveAccount);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = transactions
      .filter((t) => t.accountId === activeAccountId)
      .filter((t) => (filter === 'expense' ? t.amountMinor < 0 : filter === 'income' ? t.amountMinor > 0 : true))
      .filter((t) => {
        if (!q) return true;
        const label = CATEGORY_LABELS[t.category ?? 'other'] ?? '';
        return (
          (t.counterparty ?? '').toLowerCase().includes(q) || label.toLowerCase().includes(q)
        );
      })
      .reverse();
    const byDay = new Map<string, Transaction[]>();
    for (const t of rows) {
      const key = dayKey(t.createdAt);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(t);
      else byDay.set(key, [t]);
    }
    return [...byDay.entries()];
  }, [transactions, activeAccountId, query, filter]);

  return (
    <div className="px-4 pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="px-1 py-2.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight">История</h1>
      </header>

      <div className="flex gap-1.5 px-1">
        {accounts.map((a) => (
          <button
            key={a.id}
            className={`rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
              a.id === activeAccountId ? 'bg-ink font-medium text-bg' : 'bg-surface text-ink-2'
            }`}
            onClick={() => setActiveAccount(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2.5 rounded-btn bg-surface px-3.5 py-2.5 focus-within:ring-1 focus-within:ring-ink-3">
        <IconSearch size={18} className="shrink-0 text-ink-3" />
        <input
          className="w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-3"
          placeholder="Мерчант или категория"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="mt-2.5 flex gap-1.5 px-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`rounded-full px-3 py-1.5 text-[0.8125rem] transition-colors ${
              filter === f.id ? 'bg-surface-2 text-ink' : 'text-ink-3'
            }`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <div className="text-[0.9375rem] text-ink-2">Ничего не нашлось</div>
          <div className="max-w-56 text-[0.8125rem] text-ink-3">
            Попробуй другое название — например, «Такси» или «Продукты»
          </div>
        </div>
      ) : (
        groups.map(([key, rows]) => (
          <section key={key} className="mt-4">
            <h2 className="kicker px-1">{fmtDay(rows[0].createdAt)}</h2>
            <div className="mt-1">
              {rows.map((tx) => (
                <TxRow key={tx.id} tx={tx} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
