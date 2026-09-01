import { useMemo } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { balanceOf } from '@/domain/ledger';
import { formatMoneyWhole } from '@/domain/money';
import { APP_NAME } from '@/app/config';
import { HeroAmount } from '../primitives/Amount';
import { TxRow } from '../TxRow';
import { CometMark, IconArrowDown, IconCards, IconSettings, IconTransfer } from '../icons';

/**
 * Interest credited over the last 30 days of ledger time — makes the savings
 * APY tangible. Anchored to the newest row (pure in render), not Date.now().
 */
function useMonthlyInterest(accountId: string): number {
  const transactions = useBankStore((s) => s.transactions);
  return useMemo(() => {
    const last = transactions[transactions.length - 1];
    if (!last) return 0;
    const cutoff = new Date(last.createdAt).getTime() - 30 * 86_400_000;
    return transactions
      .filter(
        (t) =>
          t.accountId === accountId && t.kind === 'interest' && new Date(t.createdAt).getTime() > cutoff,
      )
      .reduce((s, t) => s + t.amountMinor, 0);
  }, [transactions, accountId]);
}

function QuickAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="flex flex-1 flex-col items-center gap-2 rounded-card bg-surface py-4 transition-colors active:bg-surface-2"
      onClick={onClick}
    >
      <span className="text-ink-2">{icon}</span>
      <span className="text-[0.8125rem]">{label}</span>
    </button>
  );
}

export function Home() {
  const accounts = useBankStore((s) => s.accounts);
  const transactions = useBankStore((s) => s.transactions);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const setActiveAccount = useUiStore((s) => s.setActiveAccount);
  const setScreen = useUiStore((s) => s.setScreen);
  const openSheet = useUiStore((s) => s.openSheet);
  const platform = usePlatform();

  const account = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  const balance = useBankStore((s) => balanceOf(s, account.id));
  const monthlyInterest = useMonthlyInterest(account.id);
  const user = platform.getCurrentUser();

  const recent = useMemo(
    () => transactions.filter((t) => t.accountId === account.id).slice(-4).reverse(),
    [transactions, account.id],
  );

  return (
    <div className="px-4 pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="flex items-center justify-between px-1 py-2.5">
        <div className="flex items-center gap-2">
          <CometMark size={22} className="text-ivory" />
          <span className="text-[1.0625rem] font-semibold tracking-tight">{APP_NAME}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[0.9375rem] text-ink-2">{user.displayName}</span>
          <button
            aria-label="Настройки"
            className="flex size-9 items-center justify-center rounded-full bg-surface text-ink-2 active:bg-surface-2"
            onClick={() => openSheet({ kind: 'settings' })}
          >
            <IconSettings size={19} />
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="hero-card relative mt-2 overflow-hidden rounded-card bg-surface p-5">
        <svg
          aria-hidden
          className="pointer-events-none absolute -top-10 -right-6 h-44 w-64 text-ivory/[0.07]"
          viewBox="0 0 256 176"
          fill="none"
        >
          <path d="M-20 170 C 90 150, 190 90, 260 -10" stroke="currentColor" strokeWidth="42" strokeLinecap="round" />
          <path d="M30 176 C 120 150, 200 100, 268 20" stroke="currentColor" strokeWidth="14" strokeLinecap="round" opacity="0.7" />
        </svg>

        <div className="relative flex items-start justify-between">
          <div className="flex gap-1.5">
            {accounts.map((a) => (
              <button
                key={a.id}
                className={`rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
                  a.id === account.id
                    ? 'bg-ink text-bg font-medium'
                    : 'bg-surface-2 text-ink-2 active:bg-line'
                }`}
                onClick={() => setActiveAccount(a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>
          <span className="kicker rounded-full border border-line px-2 py-1 !text-[0.5625rem]">
            демо
          </span>
        </div>

        <div className="relative mt-6">
          <HeroAmount minor={balance} />
          {account.type === 'savings' && account.apy ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="rounded-full bg-mint-dim px-2.5 py-1 text-[0.8125rem] font-medium text-mint">
                {Math.round(account.apy * 100)}% годовых
              </span>
              {monthlyInterest > 0 && (
                <span className="text-[0.8125rem] text-ink-3">
                  +{formatMoneyWhole(monthlyInterest)} за месяц
                </span>
              )}
            </div>
          ) : (
            <div className="mt-3 text-[0.8125rem] text-ink-3">
              Счёт ·· {account.number.slice(-4)}
            </div>
          )}
        </div>
      </section>

      {/* Quick actions */}
      <div className="mt-3 flex gap-3">
        <QuickAction
          label="Перевести"
          icon={<IconTransfer size={21} />}
          onClick={() => openSheet({ kind: 'transferContact' })}
        />
        <QuickAction
          label="Пополнить"
          icon={<IconArrowDown size={21} />}
          onClick={() => openSheet({ kind: 'transferOwn' })}
        />
        <QuickAction
          label="Реквизиты"
          icon={<IconCards size={21} />}
          onClick={() => openSheet({ kind: 'accountDetail', accountId: account.id })}
        />
      </div>

      {/* Recent */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="kicker">Последние операции</h2>
          <button className="text-[0.8125rem] text-ink-2" onClick={() => setScreen('history')}>
            Все
          </button>
        </div>
        <div className="mt-2">
          {recent.map((tx) => (
            <TxRow key={tx.id} tx={tx} />
          ))}
        </div>
      </section>
    </div>
  );
}
