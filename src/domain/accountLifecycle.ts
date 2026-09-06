import { appendRow, balanceOf } from './ledger';
import { applySettleAccount } from './interest';
import { isIsoTimestamp, normalizeUserText, utcDate } from './inputValidation';
import type { BankState, Currency } from './types';
import { SUPPORTED_CURRENCIES } from './currency';

const ENTITY_ID_PATTERN = /^acc_[A-Za-z0-9_.:-]{1,91}$/;
const ACCOUNT_NUMBER_PATTERN = /^[A-Z0-9 ]{10,34}$/;

export type AccountLifecycleError =
  | 'unknown_account'
  | 'account_closed'
  | 'account_active'
  | 'invalid_account'
  | 'duplicate_account'
  | 'duplicate_currency'
  | 'non_zero_balance'
  | 'last_active_account'
  | 'capacity'
  | 'balance_overflow'
  | 'invalid_date';

export type AccountLifecycleOutcome =
  | { readonly ok: true; readonly state: BankState; readonly applied: boolean }
  | { readonly ok: false; readonly error: AccountLifecycleError };

export interface AddAccountInput {
  readonly accountId: string;
  readonly currency: Currency;
  readonly name: string;
  readonly number: string;
  readonly nowISO: string;
  readonly maxAccounts?: number;
  readonly maxTransactions?: number;
}

export function applyAddAccount(state: BankState, input: AddAccountInput): AccountLifecycleOutcome {
  if (!isIsoTimestamp(input.nowISO)) return { ok: false, error: 'invalid_date' };
  const name = normalizeUserText(input.name, 48);
  if (
    !ENTITY_ID_PATTERN.test(input.accountId) ||
    !SUPPORTED_CURRENCIES.includes(input.currency) ||
    name === null ||
    !ACCOUNT_NUMBER_PATTERN.test(input.number)
  ) {
    return { ok: false, error: 'invalid_account' };
  }
  if (state.accounts.some((account) => account.id === input.accountId || account.number === input.number)) {
    return { ok: false, error: 'duplicate_account' };
  }
  if (
    state.accounts.some(
      (account) =>
        account.status === 'active' &&
        account.type === 'checking' &&
        account.currency === input.currency,
    )
  ) {
    return { ok: false, error: 'duplicate_currency' };
  }
  if (state.accounts.length >= (input.maxAccounts ?? 24) || state.transactions.length >= (input.maxTransactions ?? 5_000)) {
    return { ok: false, error: 'capacity' };
  }
  const account = {
    id: input.accountId,
    type: 'checking' as const,
    role: 'custom' as const,
    status: 'active' as const,
    name,
    currency: input.currency,
    number: input.number,
    createdAt: input.nowISO,
  };
  try {
    return {
      ok: true,
      applied: true,
      state: appendRow(
        { ...state, accounts: [...state.accounts, account] },
        {
          accountId: account.id,
          amountMinor: 0,
          kind: 'seed',
          counterparty: 'Account opened',
          category: 'other',
          effectiveDate: utcDate(input.nowISO),
          createdAt: input.nowISO,
        },
      ),
    };
  } catch (error: unknown) {
    if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
    throw error;
  }
}

export function applyCloseAccount(
  state: BankState,
  accountId: string,
  nowISO: string,
): AccountLifecycleOutcome {
  if (!isIsoTimestamp(nowISO)) return { ok: false, error: 'invalid_date' };
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (!account) return { ok: false, error: 'unknown_account' };
  if (account.status === 'closed') return { ok: true, state, applied: false };
  let settled: BankState;
  try {
    settled = applySettleAccount(state, accountId, nowISO);
  } catch (error: unknown) {
    if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
    throw error;
  }
  if (balanceOf(settled, accountId) !== 0) return { ok: false, error: 'non_zero_balance' };
  if (settled.accounts.filter((candidate) => candidate.status === 'active').length <= 1) {
    return { ok: false, error: 'last_active_account' };
  }
  return {
    ok: true,
    applied: true,
    state: {
      ...settled,
      accounts: settled.accounts.map((candidate) =>
        candidate.id === accountId
          ? {
              ...candidate,
              status: 'closed',
              closedAt: nowISO,
              ...(candidate.type === 'savings' ? { accrualAnchor: nowISO } : {}),
            }
          : candidate,
      ),
      cards: settled.cards.map((card) =>
        card.accountId === accountId && card.status === 'active'
          ? { ...card, status: 'frozen', freezeReason: 'account_closed' }
          : card,
      ),
      recurringRules: settled.recurringRules.map((rule) =>
        rule.accountId === accountId && rule.status === 'active'
          ? { ...rule, status: 'paused', pauseReason: 'account_closed' }
          : rule,
      ),
    },
  };
}

export function applyRestoreAccount(
  state: BankState,
  accountId: string,
  nowISO: string,
): AccountLifecycleOutcome {
  if (!isIsoTimestamp(nowISO)) return { ok: false, error: 'invalid_date' };
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (!account) return { ok: false, error: 'unknown_account' };
  if (account.status === 'active') return { ok: true, state, applied: false };
  if (
    account.type === 'checking' &&
    state.accounts.some(
      (candidate) =>
        candidate.id !== account.id &&
        candidate.status === 'active' &&
        candidate.type === 'checking' &&
        candidate.currency === account.currency,
    )
  ) {
    return { ok: false, error: 'duplicate_currency' };
  }
  return {
    ok: true,
    applied: true,
    state: {
      ...state,
      accounts: state.accounts.map((candidate) =>
        candidate.id === accountId
          ? (() => {
              const open = { ...candidate };
              delete open.closedAt;
              return {
                ...open,
                status: 'active' as const,
                ...(candidate.type === 'savings' ? { accrualAnchor: nowISO } : {}),
              };
            })()
          : candidate,
      ),
      cards: state.cards.map((card) =>
        card.accountId === accountId && card.freezeReason === 'account_closed'
          ? (() => {
              const active = { ...card };
              delete active.freezeReason;
              return { ...active, status: 'active' as const };
            })()
          : card,
      ),
      recurringRules: state.recurringRules.map((rule) =>
        rule.accountId === accountId && rule.pauseReason === 'account_closed'
          ? (() => {
              const active = { ...rule };
              delete active.pauseReason;
              return { ...active, status: 'active' as const };
            })()
          : rule,
      ),
    },
  };
}
