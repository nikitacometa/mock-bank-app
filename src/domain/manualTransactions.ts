import { appendRow, balanceOf } from './ledger';
import { parseAmountInput, parseBalanceInput, type MoneyLocale } from './money';
import { applySettleAccount } from './interest';
import { isAllowedEffectiveDate, isIsoTimestamp, normalizeUserText, utcDate } from './inputValidation';
import { isWithinCommandUsdLimit } from './commandLimits';
import type { BankState, Money, RecurringDirection } from './types';

export type ManualTransactionError =
  | 'unknown_account'
  | 'account_closed'
  | 'checking_only'
  | 'invalid_amount'
  | 'invalid_counterparty'
  | 'invalid_note'
  | 'invalid_category'
  | 'invalid_date'
  | 'amount_too_large'
  | 'insufficient_funds'
  | 'capacity'
  | 'balance_overflow';

export interface RecordTransactionInput {
  readonly accountId: string;
  readonly direction: RecurringDirection;
  readonly amountInput: string;
  readonly locale: MoneyLocale;
  readonly counterparty: string;
  readonly note?: string;
  readonly category?: string;
  readonly effectiveDate: string;
  readonly nowISO: string;
  readonly recurringRuleId?: string;
  readonly occurrenceKey?: string;
  readonly maxTransactions?: number;
}

export type ManualTransactionOutcome =
  | { readonly ok: true; readonly state: BankState; readonly applied: true }
  | {
      readonly ok: false;
      readonly error: ManualTransactionError;
      readonly availableMinor?: Money;
      readonly requiredMinor?: Money;
    };

export function applyManualTransaction(
  state: BankState,
  input: RecordTransactionInput,
): ManualTransactionOutcome {
  if (!isIsoTimestamp(input.nowISO)) return { ok: false, error: 'invalid_date' };
  if (
    (input.direction !== 'income' && input.direction !== 'expense') ||
    (input.locale !== 'ru' && input.locale !== 'en')
  ) return { ok: false, error: 'invalid_amount' };
  const account = state.accounts.find((candidate) => candidate.id === input.accountId);
  if (!account) return { ok: false, error: 'unknown_account' };
  if (account.status !== 'active') return { ok: false, error: 'account_closed' };
  if (account.type !== 'checking') return { ok: false, error: 'checking_only' };
  if (!isAllowedEffectiveDate(input.effectiveDate, input.nowISO)) {
    return { ok: false, error: 'invalid_date' };
  }
  const amountMinor = parseAmountInput(input.amountInput, account.currency, input.locale);
  if (amountMinor === null) return { ok: false, error: 'invalid_amount' };
  if (!isWithinCommandUsdLimit(BigInt(amountMinor), account.currency, state.exchangeRates)) {
    return { ok: false, error: 'amount_too_large' };
  }
  const counterparty = normalizeUserText(input.counterparty, 80);
  if (counterparty === null) return { ok: false, error: 'invalid_counterparty' };
  const note = input.note === undefined ? undefined : normalizeUserText(input.note, 120, true);
  if (note === null) return { ok: false, error: 'invalid_note' };
  const category = normalizeUserText(input.category ?? 'other', 40);
  if (category === null) return { ok: false, error: 'invalid_category' };
  const maximum = input.maxTransactions ?? 5_000;
  if (state.transactions.length >= maximum) return { ok: false, error: 'capacity' };

  const availableMinor = balanceOf(state, account.id);
  if (input.direction === 'expense' && amountMinor > availableMinor) {
    return { ok: false, error: 'insufficient_funds', availableMinor, requiredMinor: amountMinor };
  }
  try {
    return {
      ok: true,
      applied: true,
      state: appendRow(state, {
        accountId: account.id,
        amountMinor: input.direction === 'expense' ? -amountMinor : amountMinor,
        kind: input.direction === 'expense' ? 'manual_expense' : 'manual_income',
        counterparty,
        category,
        ...(note ? { note } : {}),
        effectiveDate: input.effectiveDate,
        ...(input.recurringRuleId ? { recurringRuleId: input.recurringRuleId } : {}),
        ...(input.occurrenceKey ? { occurrenceKey: input.occurrenceKey } : {}),
        createdAt: input.nowISO,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
    throw error;
  }
}

export interface AdjustBalanceInput {
  readonly accountId: string;
  readonly targetAmountInput: string;
  readonly locale: MoneyLocale;
  readonly nowISO: string;
  readonly maxTransactions?: number;
}

export type AdjustBalanceOutcome =
  | { readonly ok: true; readonly state: BankState; readonly applied: boolean }
  | {
      readonly ok: false;
      readonly error:
        | 'unknown_account'
        | 'account_closed'
        | 'invalid_amount'
        | 'invalid_date'
        | 'amount_too_large'
        | 'capacity'
        | 'balance_overflow';
    };

export function applyBalanceAdjustment(
  state: BankState,
  input: AdjustBalanceInput,
): AdjustBalanceOutcome {
  if (!isIsoTimestamp(input.nowISO)) return { ok: false, error: 'invalid_date' };
  if (input.locale !== 'ru' && input.locale !== 'en') {
    return { ok: false, error: 'invalid_amount' };
  }
  const account = state.accounts.find((candidate) => candidate.id === input.accountId);
  if (!account) return { ok: false, error: 'unknown_account' };
  if (account.status !== 'active') return { ok: false, error: 'account_closed' };
  const target = parseBalanceInput(input.targetAmountInput, account.currency, input.locale);
  if (target === null) return { ok: false, error: 'invalid_amount' };

  try {
    const settled = applySettleAccount(state, account.id, input.nowISO);
    const maximum = input.maxTransactions ?? 5_000;
    if (settled.transactions.length > maximum) return { ok: false, error: 'capacity' };
    const current = balanceOf(settled, account.id);
    if (target === current) return { ok: true, state: settled, applied: settled !== state };
    if (settled.transactions.length >= maximum) {
      return { ok: false, error: 'capacity' };
    }
    const amountMinor = target - current;
    if (!Number.isSafeInteger(amountMinor)) return { ok: false, error: 'balance_overflow' };
    if (!isWithinCommandUsdLimit(BigInt(amountMinor < 0 ? -amountMinor : amountMinor), account.currency, settled.exchangeRates)) {
      return { ok: false, error: 'amount_too_large' };
    }
    return {
      ok: true,
      applied: true,
      state: appendRow(settled, {
        accountId: account.id,
        amountMinor,
        kind: 'balance_adjustment',
        counterparty: 'Balance correction',
        category: 'other',
        effectiveDate: utcDate(input.nowISO),
        createdAt: input.nowISO,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
    throw error;
  }
}
