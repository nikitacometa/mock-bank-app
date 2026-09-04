import { memo, useMemo } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import type { PlatformUser } from '@/platform/types';
import { balanceOf } from '@/domain/ledger';
import { convertMoney, SUPPORTED_CURRENCIES } from '@/domain/currency';
import { formatMoneyWhole } from '@/domain/money';
import type {
  Account,
  BankState,
  Currency,
  ExchangeRateSnapshot,
  Money,
  Profile,
} from '@/domain/types';
import { APP_NAME } from '@/app/config';
import { useI18n, type AppLocale } from '@/i18n';
import { localizeDemoText } from '../format';
import { HeroAmount } from '../primitives/Amount';
import { useCountUp } from '../primitives/useCountUp';
import { TxRow } from '../TxRow';
import { AccountStrip } from '../AccountStrip';
import { CurrencyBadge } from '../CurrencyBadge';
import { UsdEquivalent } from '../UsdEquivalent';
import { CometMark, IconArrowDown, IconCards, IconSettings, IconTransfer } from '../icons';

interface UsdEquivalentInput {
  displayedBalance: Money;
  activeAccount: Account;
  exchangeRates: ExchangeRateSnapshot;
}

interface PortfolioDisplayInput {
  accounts: Account[];
  transactions: BankState['transactions'];
  primaryCurrency: Currency;
  exchangeRates: ExchangeRateSnapshot;
  paused: boolean;
}

export interface PortfolioDisplay {
  amountMinor: Money | null;
  currency: Currency;
  paused: boolean;
  motionKey: string;
}

export function platformUserDisplayName(user: PlatformUser, locale: AppLocale): string {
  return user.source === 'demo'
    ? localizeDemoText(user.displayName, locale)
    : user.displayName;
}

export function resolveUserDisplayName(
  profile: Profile,
  platformUser: PlatformUser,
  locale: AppLocale,
): string {
  return profile.telegramId === undefined
    ? platformUserDisplayName(platformUser, locale)
    : profile.displayName;
}

/** Keep USD tied to the exact balance frame currently visible in the hero. */
export function deriveUsdEquivalent({
  displayedBalance,
  activeAccount,
  exchangeRates,
}: UsdEquivalentInput): Money | null {
  try {
    return convertMoney(displayedBalance, activeAccount.currency, 'USD', exchangeRates);
  } catch {
    // Invalid or unavailable reference rates hide the estimate without affecting the real balance.
    return null;
  }
}

function portfolioMotionKey(
  primaryCurrency: Currency,
  exchangeRates: ExchangeRateSnapshot,
): string {
  const ratesVersion = SUPPORTED_CURRENCIES.map(
    (currency) => `${currency}:${exchangeRates.rates[currency]}`,
  ).join('|');
  return [
    primaryCurrency,
    exchangeRates.source,
    exchangeRates.asOf,
    exchangeRates.fetchedAt,
    ratesVersion,
  ].join('|');
}

/**
 * Portfolio has its own animation target. A stable metadata key preserves its
 * whole pre-transfer frame while paused; currency/rate changes remount it at
 * the new target so a stale number is never formatted under fresh metadata.
 */
export function derivePortfolioDisplay({
  accounts,
  transactions,
  primaryCurrency,
  exchangeRates,
  paused,
}: PortfolioDisplayInput): PortfolioDisplay {
  let amountMinor: Money | null;
  try {
    amountMinor = accounts.reduce((total, item) => {
      const converted = convertMoney(
        balanceOf({ transactions }, item.id),
        item.currency,
        primaryCurrency,
        exchangeRates,
      );
      const next = total + converted;
      if (!Number.isSafeInteger(next)) throw new RangeError('Portfolio total overflow');
      return next;
    }, 0);
  } catch {
    amountMinor = null;
  }

  return {
    amountMinor,
    currency: primaryCurrency,
    paused,
    motionKey: portfolioMotionKey(primaryCurrency, exchangeRates),
  };
}

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

function AnimatedPortfolioValue({ display }: { display: PortfolioDisplay }) {
  const { locale, t } = useI18n();
  const displayedTotal = useCountUp(display.amountMinor ?? 0, 640, display.paused);

  if (display.amountMinor === null) return null;
  return (
    <div className="mt-4 border-t border-line/60 pt-3 text-[0.75rem] text-ink-3">
      {t('home.allAccounts')} ·{' '}
      <span className="num">
        ≈ {formatMoneyWhole(displayedTotal, display.currency, locale)}
      </span>
    </div>
  );
}

function PortfolioTotalImpl({ display }: { display: PortfolioDisplay }) {
  return <AnimatedPortfolioValue key={display.motionKey} display={display} />;
}

/** Freeze the complete amount/currency/rate frame across consecutive paused renders. */
export const PortfolioTotal = memo(
  PortfolioTotalImpl,
  (previous, next) => previous.display.paused && next.display.paused,
);

interface HeroFxFrameProps {
  displayedBalance: Money;
  activeAccount: Account;
  exchangeRates: ExchangeRateSnapshot;
  portfolioDisplay: PortfolioDisplay;
  paused: boolean;
}

function HeroFxFrameImpl({
  displayedBalance,
  activeAccount,
  exchangeRates,
  portfolioDisplay,
}: HeroFxFrameProps) {
  const usdEquivalent = deriveUsdEquivalent({
    displayedBalance,
    activeAccount,
    exchangeRates,
  });

  return (
    <>
      <UsdEquivalent
        amountMinor={usdEquivalent}
        sourceCurrency={activeAccount.currency}
        rateSource={exchangeRates.source}
        asOf={exchangeRates.asOf}
      />
      <PortfolioTotal display={portfolioDisplay} />
    </>
  );
}

/** Keep USD metadata and the portfolio total on the same paused FX frame. */
export const HeroFxFrame = memo(
  HeroFxFrameImpl,
  (previous, next) => previous.paused && next.paused,
);

export function Home() {
  const accounts = useBankStore((s) => s.accounts);
  const transactions = useBankStore((s) => s.transactions);
  const primaryCurrency = useBankStore((s) => s.primaryCurrency);
  const exchangeRates = useBankStore((s) => s.exchangeRates);
  const profile = useBankStore((s) => s.profile);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const sheet = useUiStore((s) => s.sheet);
  const setActiveAccount = useUiStore((s) => s.setActiveAccount);
  const setScreen = useUiStore((s) => s.setScreen);
  const openSheet = useUiStore((s) => s.openSheet);
  const platform = usePlatform();
  const { locale, t } = useI18n();

  const account = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
  const balance = balanceOf({ transactions }, account.id);
  const monthlyInterest = useMonthlyInterest(account.id);
  const user = platform.getCurrentUser();
  const userDisplayName = resolveUserDisplayName(profile, user, locale);
  const portfolioDisplay = derivePortfolioDisplay({
    accounts,
    transactions,
    primaryCurrency,
    exchangeRates,
    paused: sheet !== null,
  });

  const recent = useMemo(
    () =>
      transactions
        .filter((t) => t.accountId === account.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq)
        .slice(0, 4),
    [transactions, account.id],
  );

  return (
    <div className="px-4 pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="flex items-center justify-between gap-3 px-1 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <CometMark size={22} className="text-ivory" />
          <h1 className="text-[1.0625rem] font-semibold tracking-tight">{APP_NAME}</h1>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="min-w-0 truncate text-[0.9375rem] text-ink-2"
            title={userDisplayName}
          >
            <bdi dir="auto">{userDisplayName}</bdi>
          </span>
          <button
            aria-label={t('home.settings')}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-ink-2 active:bg-surface-2"
            onClick={() => openSheet({ kind: 'settings' })}
          >
            <IconSettings size={19} />
          </button>
        </div>
      </header>

      <div className="scrollbar-none -mx-4 mt-1 overflow-x-auto px-4 pb-2">
        <AccountStrip
          accounts={accounts}
          value={account.id}
          onChange={setActiveAccount}
          label={t('home.accountPicker')}
        />
      </div>

      {/* Hero */}
      <section className="hero-card relative mt-1 overflow-hidden rounded-card border border-line/60 bg-surface p-5">
        <svg
          aria-hidden
          className="pointer-events-none absolute -top-10 -right-6 h-44 w-64 text-ivory/[0.07]"
          viewBox="0 0 256 176"
          fill="none"
        >
          <path d="M-20 170 C 90 150, 190 90, 260 -10" stroke="currentColor" strokeWidth="42" strokeLinecap="round" />
          <path d="M30 176 C 120 150, 200 100, 268 20" stroke="currentColor" strokeWidth="14" strokeLinecap="round" opacity="0.7" />
        </svg>

        <div className="relative flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CurrencyBadge currency={account.currency} size={42} />
            <div className="min-w-0">
              <div className="truncate text-[0.9375rem] font-medium">
                {localizeDemoText(account.name, locale)}
              </div>
              <div className="num mt-0.5 text-[0.75rem] text-ink-3">
                {account.currency} ·· {account.number.slice(-4)}
              </div>
            </div>
          </div>
          <span className="kicker rounded-full border border-line px-2 py-1 !text-ink-2">
            {t('common.demo')}
          </span>
        </div>

        <div className="relative mt-6">
          {/* A different account may use different minor units. Remount to avoid
              briefly formatting the previous account's balance in the new currency. */}
          <HeroAmount
            key={account.id}
            minor={balance}
            currency={account.currency}
            paused={sheet !== null}
          >
            {(displayedBalance) => {
              return (
                <>
                  {account.type === 'savings' && account.apy ? (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="rounded-full bg-mint-dim px-2.5 py-1 text-[0.8125rem] font-medium text-mint">
                        {t('home.apy', { percent: Math.round(account.apy * 100) })}
                      </span>
                      {monthlyInterest > 0 && (
                        <span className="text-[0.8125rem] text-ink-3">
                          {t('home.monthInterest', {
                            amount: formatMoneyWhole(
                              monthlyInterest,
                              account.currency,
                              locale,
                            ),
                          })}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 text-[0.8125rem] text-ink-3">
                      {t('home.available')}
                    </div>
                  )}
                  <HeroFxFrame
                    displayedBalance={displayedBalance}
                    activeAccount={account}
                    exchangeRates={exchangeRates}
                    portfolioDisplay={portfolioDisplay}
                    paused={sheet !== null}
                  />
                </>
              );
            }}
          </HeroAmount>
        </div>
      </section>

      {/* Quick actions */}
      <div className="mt-3 flex gap-3">
        <QuickAction
          label={t('home.action.transfer')}
          icon={<IconTransfer size={21} />}
          onClick={() => openSheet({ kind: 'transferContact' })}
        />
        <QuickAction
          label={t('home.action.ownTransfer')}
          icon={<IconArrowDown size={21} />}
          onClick={() => openSheet({ kind: 'transferOwn' })}
        />
        <QuickAction
          label={t('home.action.details')}
          icon={<IconCards size={21} />}
          onClick={() => openSheet({ kind: 'accountDetail', accountId: account.id })}
        />
      </div>

      {/* Recent */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="kicker">{t('home.recent')}</h2>
          <button
            className="-mr-3 flex min-h-11 items-center px-3 text-[0.8125rem] text-ink-2"
            onClick={() => setScreen('history')}
          >
            {t('home.all')}
          </button>
        </div>
        <div className="mt-2">
          {recent.map((tx) => (
            <TxRow key={tx.id} tx={tx} currency={account.currency} />
          ))}
        </div>
      </section>
    </div>
  );
}
