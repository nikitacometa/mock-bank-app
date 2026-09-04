import { memo } from 'react';
import type { Currency, Transaction } from '@/domain/types';
import { formatSigned } from '@/domain/money';
import { useI18n } from '@/i18n';
import { categoryLabel, fmtTime, localizeDemoText } from './format';
import { MerchantAvatar } from './MerchantAvatar';

function TxRowComponent({
  tx,
  currency,
  onClick,
}: {
  tx: Transaction;
  currency: Currency;
  onClick?: () => void;
}) {
  const { locale, t } = useI18n();
  const income = tx.amountMinor > 0;
  const ownTransfer = tx.kind === 'transfer_own_out' || tx.kind === 'transfer_own_in';
  const counterparty = localizeDemoText(tx.counterparty, locale);
  const title = ownTransfer
    ? t(tx.kind === 'transfer_own_out' ? 'transaction.transferTo' : 'transaction.transferFrom', {
        name: counterparty,
      })
    : counterparty;
  const label = ownTransfer
    ? tx.fxSnapshot
      ? t('transaction.exchange', {
          from: tx.fxSnapshot.fromCurrency,
          to: tx.fxSnapshot.toCurrency,
        })
      : t('transaction.betweenAccounts')
    : categoryLabel(tx.category, locale);
  const content = (
    <>
      <MerchantAvatar
        merchant={ownTransfer ? undefined : tx.counterparty}
        category={tx.category}
        isInterest={tx.kind === 'interest'}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-[0.9375rem] leading-tight">
          <span className="min-w-0 truncate">{title}</span>
          {tx.status === 'pending' ? (
            <span className="shrink-0 rounded-full border border-ivory/20 bg-ivory/[0.07] px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.08em] text-ivory">
              {t('transaction.pending')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[0.8125rem] text-ink-3">
          {label} · {fmtTime(tx.createdAt, locale)}
        </span>
      </span>
      <span className={`num text-[0.9375rem] ${income ? 'text-mint' : 'text-ink'}`}>
        {formatSigned(tx.amountMinor, currency, locale)}
      </span>
    </>
  );

  const className =
    'flex min-h-15 w-full items-center gap-3.5 rounded-xl px-1 py-2.5 text-left transition-colors';
  if (onClick) {
    return (
      <button
        type="button"
        className={`${className} hover:bg-surface active:bg-surface-2`}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={className} data-transfer-group={tx.transferGroupId}>
      {content}
    </div>
  );
}

export const TxRow = memo(TxRowComponent);
TxRow.displayName = 'TxRow';
