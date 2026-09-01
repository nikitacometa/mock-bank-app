import type { BankState, Money } from './types';
import { appendRow, balanceOf } from './ledger';

/**
 * Calendar UTC days — immune to DST shifts and device clock timezone games.
 * Millisecond deltas are NOT (docs/spec.md §5.2).
 */
export function epochDayUTC(iso: string): number {
  const d = new Date(iso);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/**
 * Pure accrual: interest earned on `principalMinor` between anchor and now.
 * Clock moved back → 0, never negative. Same UTC day → 0.
 */
export function accruedInterest(
  principalMinor: Money,
  apy: number,
  anchorISO: string,
  nowISO: string,
): Money {
  const days = Math.max(0, epochDayUTC(nowISO) - epochDayUTC(anchorISO));
  if (days === 0 || principalMinor <= 0) return 0;
  return Math.round(principalMinor * ((1 + apy / 365) ** days - 1));
}

/**
 * Materialise pending interest of one account as a single ledger row
 * covering the whole missed period, and advance the anchor. Idempotent
 * within one UTC day. Interest exists only as ledger rows — there is no
 * "live ticking" display value.
 */
export function applySettleAccount(state: BankState, accountId: string, nowISO: string): BankState {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account || account.type !== 'savings' || !account.apy || !account.accrualAnchor) return state;

  const days = epochDayUTC(nowISO) - epochDayUTC(account.accrualAnchor);
  if (days <= 0) return state;

  const amount = accruedInterest(balanceOf(state, accountId), account.apy, account.accrualAnchor, nowISO);
  const withAnchor = (s: BankState): BankState => ({
    ...s,
    accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, accrualAnchor: nowISO } : a)),
  });

  // Zero balance across the period: advance the anchor without a noise row.
  if (amount <= 0) return withAnchor(state);

  return withAnchor(
    appendRow(state, {
      accountId,
      amountMinor: amount,
      kind: 'interest',
      counterparty: 'Проценты по счёту',
      category: 'interest',
      createdAt: nowISO,
    }),
  );
}

/** Settle every savings account — called on app load and day rollover. */
export function applySettleAll(state: BankState, nowISO: string): BankState {
  return state.accounts
    .filter((a) => a.type === 'savings')
    .reduce((s, a) => applySettleAccount(s, a.id, nowISO), state);
}
