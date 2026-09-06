import { appendRow, balanceOf } from './ledger';
import { parseAmountInput, type MoneyLocale } from './money';
import {
  isAllowedEffectiveDate,
  isIsoTimestamp,
  monthOccurrence,
  nextMonthOccurrence,
  normalizeUserText,
  utcDate,
} from './inputValidation';
import type { BankState, Money, RecurringDirection, RecurringPauseReason, RecurringRule } from './types';
import { isWithinCommandUsdLimit } from './commandLimits';

const RULE_ID_PATTERN = /^rr_[A-Za-z0-9_.:-]{1,92}$/;

export interface StateLimits {
  readonly maxAccounts?: number;
  readonly maxTransactions?: number;
  readonly maxRecurringRules?: number;
}

export interface RecurringWarning {
  readonly ruleId: string;
  readonly reason: Extract<RecurringPauseReason, 'capacity' | 'overflow' | 'insufficient_funds'>;
  readonly availableMinor?: Money;
  readonly requiredMinor?: Money;
}

export interface CreateRecurringInput {
  readonly ruleId: string;
  readonly accountId: string;
  readonly direction: RecurringDirection;
  readonly amountInput: string;
  readonly locale: MoneyLocale;
  readonly counterparty: string;
  readonly note?: string;
  readonly category?: string;
  readonly startYear: number;
  readonly startMonth: number;
  readonly anchorDay: number;
  readonly nowISO: string;
  readonly limits?: StateLimits;
}

export type CreateRecurringOutcome =
  | {
      readonly ok: true;
      readonly state: BankState;
      readonly applied: true;
      readonly backfilled: number;
      readonly nextOccurrence: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'unknown_account'
        | 'account_closed'
        | 'checking_only'
        | 'invalid_rule_id'
        | 'duplicate_rule_id'
        | 'invalid_amount'
        | 'invalid_counterparty'
        | 'invalid_note'
        | 'invalid_category'
        | 'invalid_date'
        | 'amount_too_large'
        | 'too_many_occurrences'
        | 'insufficient_funds'
        | 'capacity'
        | 'balance_overflow';
      readonly availableMinor?: Money;
      readonly requiredMinor?: Money;
    };

function appendOccurrence(
  state: BankState,
  rule: RecurringRule,
  effectiveDate: string,
  createdAt: string,
): BankState {
  const occurrenceKey = `${rule.id}:${effectiveDate.slice(0, 7)}`;
  if (state.transactions.some((transaction) => transaction.occurrenceKey === occurrenceKey)) {
    return state;
  }
  return appendRow(state, {
    accountId: rule.accountId,
    amountMinor: rule.direction === 'expense' ? -rule.amountMinor : rule.amountMinor,
    kind: rule.direction === 'expense' ? 'manual_expense' : 'manual_income',
    counterparty: rule.counterparty,
    category: rule.category,
    ...(rule.note ? { note: rule.note } : {}),
    effectiveDate,
    recurringRuleId: rule.id,
    occurrenceKey,
    createdAt,
  });
}

function occurrenceDates(
  first: string,
  anchorDay: number,
  throughDate: string,
  maximum: number,
): { readonly due: string[]; readonly next: string } | null {
  const due: string[] = [];
  let cursor = first;
  while (cursor <= throughDate) {
    if (due.length >= maximum) return null;
    due.push(cursor);
    const next = nextMonthOccurrence(cursor, anchorDay);
    if (next === null) return null;
    cursor = next;
  }
  return { due, next: cursor };
}

export function createRecurringRule(
  state: BankState,
  input: CreateRecurringInput,
): CreateRecurringOutcome {
  if (!isIsoTimestamp(input.nowISO)) return { ok: false, error: 'invalid_date' };
  if (!RULE_ID_PATTERN.test(input.ruleId)) return { ok: false, error: 'invalid_rule_id' };
  if (state.recurringRules.some((rule) => rule.id === input.ruleId)) {
    return { ok: false, error: 'duplicate_rule_id' };
  }
  const account = state.accounts.find((candidate) => candidate.id === input.accountId);
  if (!account) return { ok: false, error: 'unknown_account' };
  if (account.status !== 'active') return { ok: false, error: 'account_closed' };
  if (account.type !== 'checking') return { ok: false, error: 'checking_only' };
  const amountMinor = parseAmountInput(input.amountInput, account.currency, input.locale);
  if (amountMinor === null) return { ok: false, error: 'invalid_amount' };
  if (!isWithinCommandUsdLimit(BigInt(amountMinor), account.currency, state.exchangeRates)) {
    return { ok: false, error: 'amount_too_large' };
  }
  const counterparty = normalizeUserText(input.counterparty, 80);
  if (counterparty === null) return { ok: false, error: 'invalid_counterparty' };
  const note = input.note === undefined ? undefined : normalizeUserText(input.note, 120, true);
  if (note === null) return { ok: false, error: 'invalid_note' };
  const category = normalizeUserText(input.category ?? 'subscriptions', 40);
  if (category === null) return { ok: false, error: 'invalid_category' };
  const first = monthOccurrence(input.startYear, input.startMonth, input.anchorDay);
  const today = utcDate(input.nowISO);
  const startsLaterThisMonth =
    first !== null && first > today && first.slice(0, 7) === today.slice(0, 7);
  if (first === null || (!isAllowedEffectiveDate(first, input.nowISO) && !startsLaterThisMonth)) {
    return { ok: false, error: 'invalid_date' };
  }
  const occurrences = occurrenceDates(first, input.anchorDay, today, 120);
  if (occurrences === null) return { ok: false, error: 'too_many_occurrences' };
  const backfillAmountMinor = BigInt(amountMinor) * BigInt(occurrences.due.length);
  if (!isWithinCommandUsdLimit(backfillAmountMinor, account.currency, state.exchangeRates)) {
    return { ok: false, error: 'amount_too_large' };
  }
  if (state.recurringRules.length >= (input.limits?.maxRecurringRules ?? 64)) {
    return { ok: false, error: 'capacity' };
  }
  if (state.transactions.length + occurrences.due.length > (input.limits?.maxTransactions ?? 5_000)) {
    return { ok: false, error: 'capacity' };
  }

  if (input.direction === 'expense') {
    const required = Number(backfillAmountMinor);
    const available = balanceOf(state, account.id);
    if (!Number.isSafeInteger(required)) return { ok: false, error: 'balance_overflow' };
    if (required > available) {
      return {
        ok: false,
        error: 'insufficient_funds',
        availableMinor: available,
        requiredMinor: required,
      };
    }
  }

  const rule: RecurringRule = {
    id: input.ruleId,
    accountId: account.id,
    direction: input.direction,
    amountMinor,
    counterparty,
    ...(note ? { note } : {}),
    category,
    cadence: 'monthly',
    anchorDay: input.anchorDay,
    startsOn: first,
    nextOccurrence: occurrences.next,
    status: 'active',
    createdAt: input.nowISO,
  };
  let next: BankState = { ...state, recurringRules: [...state.recurringRules, rule] };
  try {
    for (const date of occurrences.due) next = appendOccurrence(next, rule, date, input.nowISO);
  } catch (error: unknown) {
    if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
    throw error;
  }
  return {
    ok: true,
    state: next,
    applied: true,
    backfilled: occurrences.due.length,
    nextOccurrence: occurrences.next,
  };
}

function pauseRule(
  state: BankState,
  ruleId: string,
  reason: RecurringWarning['reason'],
): BankState {
  return {
    ...state,
    recurringRules: state.recurringRules.map((rule) =>
      rule.id === ruleId ? { ...rule, status: 'paused', pauseReason: reason } : rule,
    ),
  };
}

export function materializeRecurringRules(
  state: BankState,
  nowISO: string,
  limits: StateLimits = {},
): { readonly state: BankState; readonly warnings: RecurringWarning[] } {
  if (!isIsoTimestamp(nowISO)) throw new RangeError('Materialization timestamp must be valid');
  const today = utcDate(nowISO);
  let next = state;
  const warnings: RecurringWarning[] = [];
  for (const original of state.recurringRules) {
    const rule = next.recurringRules.find((candidate) => candidate.id === original.id);
    if (!rule || rule.status !== 'active' || rule.nextOccurrence > today) continue;
    const account = next.accounts.find((candidate) => candidate.id === rule.accountId);
    if (!account || account.status !== 'active' || account.type !== 'checking') continue;
    const occurrences = occurrenceDates(rule.nextOccurrence, rule.anchorDay, today, 120);
    const missingDue = occurrences?.due.filter((date) => {
      const key = `${rule.id}:${date.slice(0, 7)}`;
      return !next.transactions.some((transaction) => transaction.occurrenceKey === key);
    });
    if (
      occurrences === null ||
      missingDue === undefined ||
      next.transactions.length + missingDue.length > (limits.maxTransactions ?? 5_000)
    ) {
      next = pauseRule(next, rule.id, 'capacity');
      warnings.push({ ruleId: rule.id, reason: 'capacity' });
      continue;
    }
    const required = Number(BigInt(rule.amountMinor) * BigInt(missingDue.length));
    if (!Number.isSafeInteger(required)) {
      next = pauseRule(next, rule.id, 'overflow');
      warnings.push({ ruleId: rule.id, reason: 'overflow' });
      continue;
    }
    const available = balanceOf(next, rule.accountId);
    if (rule.direction === 'expense' && required > available) {
      next = pauseRule(next, rule.id, 'insufficient_funds');
      warnings.push({
        ruleId: rule.id,
        reason: 'insufficient_funds',
        availableMinor: available,
        requiredMinor: required,
      });
      continue;
    }

    let candidate = next;
    let failed = false;
    try {
      for (const date of missingDue) {
        candidate = appendOccurrence(candidate, rule, date, nowISO);
      }
    } catch (error: unknown) {
      if (error instanceof RangeError) {
        failed = true;
      } else {
        throw error;
      }
    }
    if (failed) {
      next = pauseRule(next, rule.id, 'overflow');
      warnings.push({ ruleId: rule.id, reason: 'overflow' });
      continue;
    }
    next = {
      ...candidate,
      recurringRules: candidate.recurringRules.map((candidateRule) =>
        candidateRule.id === rule.id
          ? { ...candidateRule, nextOccurrence: occurrences.next }
          : candidateRule,
      ),
    };
  }
  return { state: next, warnings };
}
