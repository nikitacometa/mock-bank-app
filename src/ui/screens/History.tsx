import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import type { Transaction } from '@/domain/types';
import { useI18n, type TranslationKey } from '@/i18n';
import { categoryLabel, dayKey, fmtDay, localizeDemoText } from '../format';
import { TxRow } from '../TxRow';
import { AccountStrip } from '../AccountStrip';
import { IconSearch } from '../icons';

type Filter = 'all' | 'expense' | 'income';

const FILTERS: Array<{ id: Filter; labelKey: TranslationKey }> = [
  { id: 'all', labelKey: 'history.filter.all' },
  { id: 'expense', labelKey: 'history.filter.expense' },
  { id: 'income', labelKey: 'history.filter.income' },
];
const INITIAL_VISIBLE_GROUPS = 24;
const GROUPS_PER_PAGE = 16;

export function History() {
  const accounts = useBankStore((s) => s.accounts);
  const transactions = useBankStore((s) => s.transactions);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const setActiveAccount = useUiStore((s) => s.setActiveAccount);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleGroupCount, setVisibleGroupCount] = useState(INITIAL_VISIBLE_GROUPS);
  const [announcedVisibleCount, setAnnouncedVisibleCount] = useState(0);
  const [focusGroupIndex, setFocusGroupIndex] = useState<number | null>(null);
  const nextGroupHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const { locale, t } = useI18n();
  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? accounts[0];

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const rows = transactions
      .filter((t) => t.accountId === activeAccount.id)
      .filter((t) => (filter === 'expense' ? t.amountMinor < 0 : filter === 'income' ? t.amountMinor > 0 : true))
      .filter((t) => {
        if (!q) return true;
        const label = categoryLabel(t.category, locale);
        const counterparty = localizeDemoText(t.counterparty, locale);
        return (
          counterparty.toLocaleLowerCase(locale).includes(q) ||
          label.toLocaleLowerCase(locale).includes(q)
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq);
    const byDay = new Map<string, Transaction[]>();
    for (const t of rows) {
      const key = dayKey(t.createdAt);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(t);
      else byDay.set(key, [t]);
    }
    return [...byDay.entries()];
  }, [transactions, activeAccount.id, deferredQuery, filter, locale]);
  const visibleGroups = groups.slice(0, visibleGroupCount);

  useEffect(() => {
    if (focusGroupIndex === null) return;
    nextGroupHeadingRef.current?.focus();
  }, [focusGroupIndex, visibleGroupCount]);

  const resetWindow = () => {
    setFocusGroupIndex(null);
    setAnnouncedVisibleCount(0);
    setVisibleGroupCount(INITIAL_VISIBLE_GROUPS);
  };

  const selectAccount = (accountId: string) => {
    resetWindow();
    setActiveAccount(accountId);
  };

  const revealMore = () => {
    const firstNewIndex = visibleGroups.length;
    const nextVisibleCount = Math.min(groups.length, firstNewIndex + GROUPS_PER_PAGE);
    setFocusGroupIndex(firstNewIndex);
    setAnnouncedVisibleCount(nextVisibleCount);
    setVisibleGroupCount(nextVisibleCount);
  };

  return (
    <div className="px-4 pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="px-1 py-2.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight">{t('history.title')}</h1>
      </header>

      <div className="scrollbar-none -mx-4 overflow-x-auto px-4">
        <AccountStrip
          accounts={accounts}
          value={activeAccount.id}
          onChange={selectAccount}
          label={t('history.accountPicker')}
          compact
        />
      </div>

      <label className="mt-3 flex items-center gap-2.5 rounded-btn bg-surface px-3.5 py-2.5 focus-within:ring-1 focus-within:ring-ink-3">
        <IconSearch size={18} className="shrink-0 text-ink-3" />
        <input
          className="w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-3"
          placeholder={t('history.searchPlaceholder')}
          aria-label={t('history.searchLabel')}
          value={query}
          onChange={(e) => {
            resetWindow();
            setQuery(e.target.value);
          }}
        />
      </label>

      <div className="mt-2.5 flex gap-1.5 px-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`min-h-11 rounded-full px-3 text-[0.8125rem] transition-colors ${
              filter === f.id ? 'bg-surface-2 text-ink' : 'text-ink-3'
            }`}
            onClick={() => {
              resetWindow();
              setFilter(f.id);
            }}
            aria-pressed={filter === f.id}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <div className="text-[0.9375rem] text-ink-2">{t('history.empty.title')}</div>
          <div className="max-w-56 text-[0.8125rem] text-ink-3">
            {t('history.empty.description')}
          </div>
        </div>
      ) : (
        <>
          {visibleGroups.map(([key, rows], index) => (
            <section key={key} className="mt-4">
              <h2
                ref={index === focusGroupIndex ? nextGroupHeadingRef : undefined}
                className="kicker px-1"
                tabIndex={-1}
              >
                {fmtDay(rows[0].createdAt, locale)}
              </h2>
              <div className="mt-1">
                {rows.map((tx) => (
                  <TxRow key={tx.id} tx={tx} currency={activeAccount.currency} />
                ))}
              </div>
            </section>
          ))}
          {visibleGroups.length < groups.length ? (
            <button
              type="button"
              className="mt-5 min-h-11 w-full rounded-btn border border-line bg-surface px-4 text-[0.875rem] font-medium text-ink-2 transition-colors hover:bg-surface-2 active:bg-surface-2"
              onClick={revealMore}
            >
              {t('history.showMore')}
            </button>
          ) : null}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcedVisibleCount > 0
              ? t('history.revealed', { visible: announcedVisibleCount, total: groups.length })
              : ''}
          </span>
        </>
      )}
    </div>
  );
}
