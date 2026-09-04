import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { balanceOf } from '@/domain/ledger';
import { epochDayUTC } from '@/domain/interest';
import { CURRENCY_METADATA, convertMoney, quoteCrossRate } from '@/domain/currency';
import {
  formatMoney,
  formatMoneyDelta,
  formatMoneyShortfall,
  parseAmountInput,
} from '@/domain/money';
import type { TransferError } from '@/domain/transfer';
import type { Currency, Money } from '@/domain/types';
import {
  currencyName,
  useI18n,
  type AppLocale,
  type TranslationKey,
} from '@/i18n';
import { Sheet } from '../../primitives/Sheet';
import { PrimaryAction } from '../../primitives/PrimaryAction';
import { Avatar } from '../../primitives/Avatar';
import { IconBackspace } from '../../icons';
import { AccountStrip } from '../../AccountStrip';
import { createClientTransferId } from '../../clientTransferId';
import { fmtRateDate, localizeDemoText } from '../../format';

type Mode = 'contact' | 'own';

interface SuccessReceipt {
  readonly amount: Money;
  readonly fromCurrency: Currency;
  readonly recipient:
    | { readonly kind: 'amount'; readonly amount: Money; readonly currency: Currency }
    | { readonly kind: 'name'; readonly name?: string };
}

interface ClientTransferIntent {
  readonly mode: Mode;
  readonly fromAccountId: string;
  readonly recipientId: string;
  readonly amountMinor: Money;
}

function isSameClientTransferIntent(
  previous: ClientTransferIntent | null,
  current: ClientTransferIntent,
): boolean {
  return (
    previous !== null &&
    previous.mode === current.mode &&
    previous.fromAccountId === current.fromAccountId &&
    previous.recipientId === current.recipientId &&
    previous.amountMinor === current.amountMinor
  );
}

function transferErrorKey(error: TransferError): TranslationKey {
  switch (error) {
    case 'insufficient_funds':
      return 'transfer.error.insufficient';
    case 'converted_amount_too_small':
      return 'transfer.error.tooSmall';
    case 'invalid_exchange_rate':
      return 'transfer.error.rate';
    case 'balance_overflow':
      return 'transfer.error.overflow';
    default:
      return 'transfer.error.generic';
  }
}

function decimalSeparator(locale: AppLocale): ',' | '.' {
  return locale === 'ru' ? ',' : '.';
}

/** Exact mount preflight used by the sheet and by its real-store regression. */
export function preflightTransferBalances(
  settleNow: () => Promise<void>,
): Promise<void> {
  return settleNow();
}

/**
 * Keep the sheet's ledger view current without an interest timer. Mount and the
 * first interaction on a new UTC day share one in-flight settlement.
 */
export function useTransferPreflight(
  settleNow: () => Promise<void>,
): () => Promise<void> {
  const settledDayRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const ensureCurrentDay = useCallback(async function ensureCurrentDay(): Promise<void> {
    const day = epochDayUTC(new Date().toISOString());
    if (settledDayRef.current === day) return;

    if (inFlightRef.current !== null) {
      await inFlightRef.current;
      return ensureCurrentDay();
    }

    const settlement = preflightTransferBalances(settleNow);
    inFlightRef.current = settlement;
    try {
      await settlement;
      settledDayRef.current = day;
    } finally {
      if (inFlightRef.current === settlement) inFlightRef.current = null;
    }
  }, [settleNow]);

  useEffect(() => {
    void ensureCurrentDay();
  }, [ensureCurrentDay]);

  return ensureCurrentDay;
}

/** Canonical "12345.6" → locale-specific draft without touching money arithmetic. */
export function formatDraftAmount(raw: string, locale: AppLocale): string {
  const [integer, fraction] = raw.split('.');
  const group = locale === 'ru' ? '\u202F' : ',';
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return fraction === undefined
    ? grouped
    : `${grouped}${decimalSeparator(locale)}${fraction}`;
}

export function appendDraftKey(
  raw: string,
  key: string,
  currency: Currency,
  locale: AppLocale,
): string {
  if (key === '⌫') return raw.slice(0, -1);
  if (key === decimalSeparator(locale)) {
    if (CURRENCY_METADATA[currency].displayDigits === 0 || raw.includes('.')) return raw;
    return raw === '' ? '0.' : `${raw}.`;
  }

  const [integer, fraction] = raw.split('.');
  if (fraction !== undefined) {
    return fraction.length >= CURRENCY_METADATA[currency].displayDigits ? raw : raw + key;
  }
  if (integer.length >= 12) return raw;
  if (integer === '0') return key;
  return raw + key;
}

function SuccessScene({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-4 px-5 pt-6 pb-10">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden>
        <circle
          cx="36" cy="36" r="30" stroke="var(--color-mint)" strokeWidth="3"
          strokeDasharray="189" strokeDashoffset="189" strokeLinecap="round"
          style={{ animation: 'draw-stroke 420ms var(--ease-out-premium) forwards' }}
        />
        <path
          d="m24 37.5 8.5 8.5L48.5 29" stroke="var(--color-mint)" strokeWidth="4"
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray="36" strokeDashoffset="36"
          style={{ animation: 'draw-stroke 260ms var(--ease-out-premium) 360ms forwards' }}
        />
      </svg>
      <div className="text-[1.0625rem] font-medium">{text}</div>
    </div>
  );
}

export function TransferSheet({ initialMode }: { initialMode: Mode }) {
  const accounts = useBankStore((s) => s.accounts);
  const contacts = useBankStore((s) => s.contacts);
  const transactions = useBankStore((s) => s.transactions);
  const exchangeRates = useBankStore((s) => s.exchangeRates);
  const transfer = useBankStore((s) => s.transfer);
  const settleNow = useBankStore((s) => s.settleNow);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const platform = usePlatform();
  const { locale, t } = useI18n();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [raw, setRaw] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const active = accounts.find((account) => account.id === activeAccountId)?.id ?? accounts[0].id;
  const other = accounts.find((account) => account.id !== active)?.id ?? active;
  const [ownFrom, setOwnFrom] = useState(active);
  const [ownTo, setOwnTo] = useState(other);
  const [contactFrom, setContactFrom] = useState(active);
  const [success, setSuccess] = useState<SuccessReceipt | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bind the key to the exact submitted intent: retries/double taps reuse it,
  // while any semantic request change mints a fresh key at the next submit.
  const clientTransferId = useRef<string | null>(null);
  const clientTransferIntent = useRef<ClientTransferIntent | null>(null);
  const ensureBalancesCurrent = useTransferPreflight(settleNow);

  const sortedContacts = useMemo(
    () =>
      [...contacts].sort((a, b) => {
        if (a.lastTransferAt && b.lastTransferAt) return b.lastTransferAt.localeCompare(a.lastTransferAt);
        if (a.lastTransferAt) return -1;
        if (b.lastTransferAt) return 1;
        return localizeDemoText(a.name, locale).localeCompare(
          localizeDemoText(b.name, locale),
          locale === 'ru' ? 'ru' : 'en',
        );
      }),
    [contacts, locale],
  );

  const localizedAccounts = useMemo(
    () => accounts.map((account) => ({ ...account, name: localizeDemoText(account.name, locale) })),
    [accounts, locale],
  );

  const fromId = mode === 'own' ? ownFrom : contactFrom;
  const fromAccount = accounts.find((account) => account.id === fromId) ?? accounts[0];
  const toAccount = accounts.find((account) => account.id === ownTo) ?? accounts[0];
  const available = balanceOf({ transactions }, fromId);
  const amount = raw === '' ? null : parseAmountInput(raw, fromAccount.currency, locale);
  const insufficient = amount !== null && amount > available;
  const recipientOk = mode === 'own' ? ownFrom !== ownTo : contactId !== null;
  const canSubmit = amount !== null && !insufficient && recipientOk && !success && !submitting;
  const amountDisplay = raw === '' ? '0' : formatDraftAmount(raw, locale);
  const integerDigits = (raw.split('.')[0] || '0').length;
  const amountSizeClass =
    integerDigits >= 11
      ? 'text-[1.5rem]'
      : integerDigits >= 9
        ? 'text-[1.75rem]'
        : 'text-[2.25rem]';

  const convertedAmount = useMemo(() => {
    if (mode !== 'own' || amount === null || fromAccount.currency === toAccount.currency) return amount;
    try {
      return convertMoney(amount, fromAccount.currency, toAccount.currency, exchangeRates);
    } catch {
      return null;
    }
  }, [mode, amount, fromAccount.currency, toAccount.currency, exchangeRates]);

  const quotedRate = useMemo(() => {
    if (fromAccount.currency === toAccount.currency) return null;
    try {
      const exact = quoteCrossRate(
        fromAccount.currency,
        toAccount.currency,
        exchangeRates.rates[fromAccount.currency],
        exchangeRates.rates[toAccount.currency],
      );
      const numeric = Number(exact);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return numeric.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
        maximumSignificantDigits: 6,
      });
    } catch {
      return null;
    }
  }, [exchangeRates, fromAccount.currency, locale, toAccount.currency]);

  const successText = useMemo(() => {
    if (!success) return '';
    const recipient = success.recipient.kind === 'amount'
      ? formatMoneyDelta(
          success.recipient.amount,
          success.recipient.currency,
          locale,
        )
      : success.recipient.name === undefined
        ? t('transfer.recipientFallback')
        : localizeDemoText(success.recipient.name, locale);
    return `${formatMoney(success.amount, success.fromCurrency, locale)} → ${recipient}`;
  }, [locale, success, t]);

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(closeSheet, 2400);
    return () => window.clearTimeout(timer);
  }, [success, closeSheet]);

  const tap = (key: string) => {
    void ensureBalancesCurrent();
    platform.haptic('light');
    setErrorKey(null);
    setRaw((value) => appendDraftKey(value, key, fromAccount.currency, locale));
  };

  const submit = async () => {
    if (!canSubmit || amount === null) return;
    setSubmitting(true);
    try {
      await ensureBalancesCurrent();
      const intent: ClientTransferIntent = {
        mode,
        fromAccountId: mode === 'own' ? ownFrom : contactFrom,
        recipientId: mode === 'own' ? ownTo : contactId!,
        amountMinor: amount,
      };
      let key = clientTransferId.current;
      if (key === null || !isSameClientTransferIntent(clientTransferIntent.current, intent)) {
        key = createClientTransferId();
        clientTransferId.current = key;
        clientTransferIntent.current = intent;
      }
      const outcome = await transfer(
        mode === 'own'
          ? { fromAccountId: ownFrom, toAccountId: ownTo, amountMinor: amount, clientTransferId: key }
          : { fromAccountId: contactFrom, toContactId: contactId!, amountMinor: amount, clientTransferId: key },
      );
      if (outcome.ok) {
        platform.haptic('success');
        const recipient: SuccessReceipt['recipient'] =
          mode === 'own'
            ? outcome.applied && outcome.incomingAmountMinor !== undefined
              ? {
                  kind: 'amount',
                  amount: outcome.incomingAmountMinor,
                  currency: toAccount.currency,
                }
              : { kind: 'name', name: toAccount.name }
            : {
                kind: 'name',
                name: contacts.find((contact) => contact.id === contactId)?.name,
              };
        setSuccess({ amount, fromCurrency: fromAccount.currency, recipient });
      } else {
        platform.haptic('warning');
        setErrorKey(transferErrorKey(outcome.error));
      }
    } catch (cause: unknown) {
      platform.haptic('warning');
      const message = cause instanceof Error ? cause.message : 'unknown error';
      console.error(`[transfer] unexpected failure: ${message}`);
      setErrorKey('transfer.error.generic');
    } finally {
      setSubmitting(false);
    }
  };

  const chooseSource = (id: string, setter: (accountId: string) => void) => {
    setter(id);
    setRaw('');
    setErrorKey(null);
  };

  const chooseMode = (nextMode: Mode) => {
    if (nextMode !== mode) {
      setRaw('');
    }
    setMode(nextMode);
    setErrorKey(null);
  };

  return (
    <Sheet open onClose={closeSheet} title={success ? t('transfer.done') : t('transfer.title')}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {successText}
      </span>
      {success ? (
        <SuccessScene text={successText} />
      ) : (
        <div
          className="px-5 pb-2"
          onPointerDownCapture={() => void ensureBalancesCurrent()}
          onKeyDownCapture={() => void ensureBalancesCurrent()}
        >
          <div className="mt-1 flex gap-1.5">
            {(['contact', 'own'] as const).map((m) => (
              <button
                key={m}
                className={`min-h-11 rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
                  mode === m ? 'bg-surface-2 text-ink' : 'text-ink-3'
                }`}
                onClick={() => chooseMode(m)}
                aria-pressed={mode === m}
              >
                {m === 'contact' ? t('transfer.mode.contact') : t('transfer.mode.own')}
              </button>
            ))}
          </div>

          {mode === 'contact' ? (
            <div className="scrollbar-none -mx-5 mt-4 flex gap-4 overflow-x-auto px-5">
              {sortedContacts.map((contact) => {
                const name = localizeDemoText(contact.name, locale);
                const initials = name === contact.name
                  ? contact.initials
                  : name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join('')
                      .toUpperCase();
                return (
                  <button
                    key={contact.id}
                    className="flex w-14 shrink-0 flex-col items-center gap-1.5"
                    onClick={() => {
                      setContactId(contact.id);
                      setErrorKey(null);
                    }}
                    aria-pressed={contactId === contact.id}
                  >
                    <span
                      className={`rounded-full transition-shadow ${
                        contactId === contact.id
                          ? 'ring-2 ring-ivory ring-offset-2 ring-offset-surface'
                          : ''
                      }`}
                    >
                      <Avatar name={name} initials={initials} size={48} />
                    </span>
                    <span
                      className={`w-full truncate text-center text-[0.75rem] ${
                        contactId === contact.id ? 'text-ink' : 'text-ink-3'
                      }`}
                      title={name}
                    >
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div>
                <div className="kicker mb-1">{t('transfer.debit.title')}</div>
                <AccountStrip
                  accounts={localizedAccounts.filter((account) => account.id !== ownTo)}
                  value={ownFrom}
                  onChange={(id) => chooseSource(id, setOwnFrom)}
                  label={t('transfer.debit.label')}
                  compact
                />
              </div>
              <div>
                <div className="kicker mb-1">{t('transfer.credit.title')}</div>
                <AccountStrip
                  accounts={localizedAccounts.filter((account) => account.id !== ownFrom)}
                  value={ownTo}
                  onChange={(id) => {
                    setOwnTo(id);
                    setErrorKey(null);
                  }}
                  label={t('transfer.credit.label')}
                  compact
                />
              </div>
            </div>
          )}

          {mode === 'contact' && (
            <div className="mt-4">
              <div className="kicker mb-1">{t('transfer.debit.title')}</div>
              <AccountStrip
                accounts={localizedAccounts}
                value={contactFrom}
                onChange={(id) => chooseSource(id, setContactFrom)}
                label={t('transfer.debit.label')}
                compact
              />
            </div>
          )}

          <div className="mt-5 text-center">
            <output
              className={`num block whitespace-nowrap leading-none font-medium ${amountSizeClass}`}
              aria-live="polite"
              aria-atomic="true"
              aria-label={t('transfer.amountLabel', {
                amount: amountDisplay,
                currency: currencyName(locale, fromAccount.currency),
              })}
            >
              {locale === 'en' && (
                <span className="text-ink-3">{CURRENCY_METADATA[fromAccount.currency].symbol}</span>
              )}
              {raw === '' ? <span className="text-ink-3">0</span> : amountDisplay}
              {locale === 'ru' && (
                <span className="text-ink-3"> {CURRENCY_METADATA[fromAccount.currency].symbol}</span>
              )}
            </output>
            <div
              className={`mt-2 text-[0.8125rem] ${insufficient || errorKey ? 'text-coral' : 'text-ink-3'}`}
              aria-live="polite"
            >
              {errorKey ? t(errorKey) :
                (insufficient && amount !== null
                  ? t('transfer.shortfall', {
                      amount: formatMoneyShortfall(
                        amount - available,
                        fromAccount.currency,
                        locale,
                      ),
                    })
                  : t('transfer.available', {
                      amount: formatMoney(available, fromAccount.currency, locale),
                    }))}
            </div>
            {mode === 'own' && fromAccount.currency !== toAccount.currency && (
              <div className="mt-3 rounded-btn border border-line/70 bg-surface-2/50 px-3.5 py-3 text-left">
                <div className="flex items-center justify-between gap-3 text-[0.8125rem]">
                  <span className="text-ink-3">{t('transfer.receive')}</span>
                  <span className="num text-ink">
                    {convertedAmount === null
                      ? '—'
                      : formatMoneyDelta(convertedAmount, toAccount.currency, locale)}
                  </span>
                </div>
                <div className="mt-1.5 text-[0.6875rem] leading-relaxed text-ink-3">
                  {quotedRate
                    ? t('transfer.quote', {
                        from: fromAccount.currency,
                        rate: quotedRate,
                        to: toAccount.currency,
                        date: fmtRateDate(exchangeRates.asOf, locale),
                      })
                    : t('transfer.rateUnavailable')}
                </div>
              </div>
            )}
          </div>

          <div className="mx-auto mt-4 grid max-w-72 grid-cols-3 gap-1">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', decimalSeparator(locale), '0', '⌫'].map((k) => (
              <button
                key={k}
                aria-label={k === '⌫' ? t('transfer.erase') : k}
                className="num flex h-13 items-center justify-center rounded-btn text-[1.375rem] transition-colors active:bg-surface-2"
                onClick={() => tap(k)}
                disabled={
                  k === decimalSeparator(locale) &&
                  CURRENCY_METADATA[fromAccount.currency].displayDigits === 0
                }
              >
                {k === '⌫' ? (
                  <IconBackspace size={22} className="text-ink-2" />
                ) : k === decimalSeparator(locale) &&
                  CURRENCY_METADATA[fromAccount.currency].displayDigits === 0 ? (
                  <span className="text-line">·</span>
                ) : (
                  k
                )}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <PrimaryAction
              text={
                amount !== null && recipientOk && !insufficient
                  ? t('transfer.actionAmount', {
                      amount: formatMoney(amount, fromAccount.currency, locale),
                    })
                  : t('transfer.action')
              }
              onClick={submit}
              disabled={!canSubmit}
            />
          </div>
        </div>
      )}
    </Sheet>
  );
}
