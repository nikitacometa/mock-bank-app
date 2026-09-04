import { useEffect, useRef } from 'react';
import type { Account } from '@/domain/types';
import { useI18n } from '@/i18n';
import { localizeDemoText } from './format';
import { CurrencyBadge } from './CurrencyBadge';

interface AccountStripProps {
  accounts: Account[];
  value: string;
  onChange: (accountId: string) => void;
  label: string;
  compact?: boolean;
}

export function AccountStrip({ accounts, value, onChange, label, compact = false }: AccountStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const { locale } = useI18n();

  useEffect(() => {
    const strip = stripRef.current;
    const selected = [...(strip?.querySelectorAll<HTMLElement>('[data-account-id]') ?? [])].find(
      (item) => item.dataset.accountId === value,
    );
    if (!strip || !selected) return;
    const stripRect = strip.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const left =
      strip.scrollLeft +
      selectedRect.left -
      stripRect.left -
      (strip.clientWidth - selectedRect.width) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }, [value, accounts.length]);

  return (
    <div
      ref={stripRef}
      className="scrollbar-none flex snap-x gap-2 overflow-x-auto py-1"
      role="group"
      aria-label={label}
    >
      {accounts.map((account) => {
        const selected = account.id === value;
        return (
          <button
            key={account.id}
            data-account-id={account.id}
            className={`flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-full border pr-3 pl-1.5 text-left transition-colors ${
              selected
                ? 'border-ivory/45 bg-ivory/[0.08] text-ink'
                : 'border-transparent bg-surface-2 text-ink-2 active:border-line'
            }`}
            onClick={() => onChange(account.id)}
            aria-pressed={selected}
          >
            <CurrencyBadge currency={account.currency} size={32} />
            <span className="leading-tight">
              <span className="block text-[0.8125rem] font-medium">{account.currency}</span>
              <span
                className={`block truncate text-[0.6875rem] text-ink-3 ${
                  compact ? 'max-w-16' : 'max-w-24'
                }`}
              >
                {localizeDemoText(account.name, locale)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
