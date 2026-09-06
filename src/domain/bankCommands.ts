import { applyAddAccount, applyCloseAccount, applyRestoreAccount } from './accountLifecycle';
import { SUPPORTED_CURRENCIES } from './currency';
import { applySettleAllWithinTransactionLimit } from './interest';
import { applyBalanceAdjustment, applyManualTransaction } from './manualTransactions';
import { createRecurringRule, materializeRecurringRules, type RecurringWarning, type StateLimits } from './recurring';
import { rebuildDemoBase } from './seed';
import { applyTransfer, isClientTransferId, type TransferRequest } from './transfer';
import type { BankState, Currency, Money, RecurringDirection } from './types';
import type { MoneyLocale } from './money';
import { normalizeUserText } from './inputValidation';

export type BankCommand =
  | {
      readonly kind: 'record_transaction';
      readonly accountId: string;
      readonly direction: RecurringDirection;
      readonly amountInput: string;
      readonly locale: MoneyLocale;
      readonly counterparty: string;
      readonly note?: string;
      readonly category?: string;
      readonly effectiveDate: string;
    }
  | {
      readonly kind: 'create_recurring';
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
    }
  | { readonly kind: 'pause_recurring'; readonly ruleId: string }
  | { readonly kind: 'resume_recurring'; readonly ruleId: string }
  | {
      readonly kind: 'add_account';
      readonly accountId: string;
      readonly currency: Currency;
      readonly name: string;
      readonly number: string;
    }
  | {
      readonly kind: 'adjust_balance';
      readonly accountId: string;
      readonly targetAmountInput: string;
      readonly locale: MoneyLocale;
    }
  | { readonly kind: 'close_account'; readonly accountId: string }
  | { readonly kind: 'restore_account'; readonly accountId: string }
  | { readonly kind: 'transfer'; readonly request: TransferRequest }
  | { readonly kind: 'set_primary_currency'; readonly currency: Currency }
  | { readonly kind: 'set_display_name'; readonly displayName: string }
  | { readonly kind: 'set_card_frozen'; readonly cardId: string; readonly frozen: boolean }
  | { readonly kind: 'settle' }
  | { readonly kind: 'reset_demo' };

export interface BankCommandContext {
  readonly nowISO: string;
  readonly limits?: StateLimits;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isBoundedString(value: unknown, maximum = 160): value is string {
  return typeof value === 'string' && [...value].length <= maximum;
}

function isLocale(value: unknown): value is MoneyLocale {
  return value === 'ru' || value === 'en';
}

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

function commonTransactionFields(value: UnknownRecord): boolean {
  return (
    isBoundedString(value.accountId, 96) &&
    (value.direction === 'income' || value.direction === 'expense') &&
    isBoundedString(value.amountInput, 64) &&
    isLocale(value.locale) &&
    isBoundedString(value.counterparty, 160) &&
    (value.note === undefined || isBoundedString(value.note, 240)) &&
    (value.category === undefined || isBoundedString(value.category, 80))
  );
}

/** Exact projection for untrusted HTTP/bot payloads; semantic checks stay in `applyBankCommand`. */
export function parseBankCommand(value: unknown): BankCommand | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'record_transaction':
      return hasExactKeys(
        value,
        ['kind', 'accountId', 'direction', 'amountInput', 'locale', 'counterparty', 'effectiveDate'],
        ['note', 'category'],
      ) && commonTransactionFields(value) && isBoundedString(value.effectiveDate, 10)
        ? {
            kind: value.kind,
            accountId: value.accountId as string,
            direction: value.direction as RecurringDirection,
            amountInput: value.amountInput as string,
            locale: value.locale as MoneyLocale,
            counterparty: value.counterparty as string,
            ...(value.note === undefined ? {} : { note: value.note as string }),
            ...(value.category === undefined ? {} : { category: value.category as string }),
            effectiveDate: value.effectiveDate,
          }
        : null;
    case 'create_recurring':
      return hasExactKeys(
        value,
        ['kind', 'ruleId', 'accountId', 'direction', 'amountInput', 'locale', 'counterparty', 'startYear', 'startMonth', 'anchorDay'],
        ['note', 'category'],
      ) && commonTransactionFields(value) && isBoundedString(value.ruleId, 96) && Number.isInteger(value.startYear) && Number.isInteger(value.startMonth) && Number.isInteger(value.anchorDay)
        ? {
            kind: value.kind,
            ruleId: value.ruleId,
            accountId: value.accountId as string,
            direction: value.direction as RecurringDirection,
            amountInput: value.amountInput as string,
            locale: value.locale as MoneyLocale,
            counterparty: value.counterparty as string,
            ...(value.note === undefined ? {} : { note: value.note as string }),
            ...(value.category === undefined ? {} : { category: value.category as string }),
            startYear: value.startYear as number,
            startMonth: value.startMonth as number,
            anchorDay: value.anchorDay as number,
          }
        : null;
    case 'pause_recurring':
    case 'resume_recurring':
      return hasExactKeys(value, ['kind', 'ruleId']) && isBoundedString(value.ruleId, 96)
        ? { kind: value.kind, ruleId: value.ruleId }
        : null;
    case 'add_account':
      return hasExactKeys(value, ['kind', 'accountId', 'currency', 'name', 'number']) && isBoundedString(value.accountId, 96) && isCurrency(value.currency) && isBoundedString(value.name, 96) && isBoundedString(value.number, 40)
        ? { kind: value.kind, accountId: value.accountId, currency: value.currency, name: value.name, number: value.number }
        : null;
    case 'adjust_balance':
      return hasExactKeys(value, ['kind', 'accountId', 'targetAmountInput', 'locale']) && isBoundedString(value.accountId, 96) && isBoundedString(value.targetAmountInput, 64) && isLocale(value.locale)
        ? { kind: value.kind, accountId: value.accountId, targetAmountInput: value.targetAmountInput, locale: value.locale }
        : null;
    case 'close_account':
    case 'restore_account':
      return hasExactKeys(value, ['kind', 'accountId']) && isBoundedString(value.accountId, 96)
        ? { kind: value.kind, accountId: value.accountId }
        : null;
    case 'transfer': {
      if (!hasExactKeys(value, ['kind', 'request']) || !isRecord(value.request)) return null;
      const request = value.request;
      const hasAccount = typeof request.toAccountId === 'string';
      const hasContact = typeof request.toContactId === 'string';
      if (
        hasAccount === hasContact ||
        !hasExactKeys(
          request,
          ['fromAccountId', hasAccount ? 'toAccountId' : 'toContactId', 'amountMinor', 'clientTransferId'],
        ) ||
        !isBoundedString(request.fromAccountId, 96) ||
        !Number.isSafeInteger(request.amountMinor) ||
        !isClientTransferId(request.clientTransferId)
      ) return null;
      return {
        kind: value.kind,
        request: hasAccount
          ? { fromAccountId: request.fromAccountId, toAccountId: request.toAccountId as string, amountMinor: request.amountMinor as number, clientTransferId: request.clientTransferId }
          : { fromAccountId: request.fromAccountId, toContactId: request.toContactId as string, amountMinor: request.amountMinor as number, clientTransferId: request.clientTransferId },
      };
    }
    case 'set_primary_currency':
      return hasExactKeys(value, ['kind', 'currency']) && isCurrency(value.currency)
        ? { kind: value.kind, currency: value.currency }
        : null;
    case 'set_display_name':
      return hasExactKeys(value, ['kind', 'displayName']) && isBoundedString(value.displayName, 96)
        ? { kind: value.kind, displayName: value.displayName }
        : null;
    case 'set_card_frozen':
      return hasExactKeys(value, ['kind', 'cardId', 'frozen']) && isBoundedString(value.cardId, 96) && typeof value.frozen === 'boolean'
        ? { kind: value.kind, cardId: value.cardId, frozen: value.frozen }
        : null;
    case 'settle':
      return hasExactKeys(value, ['kind']) ? { kind: value.kind } : null;
    case 'reset_demo':
      return hasExactKeys(value, ['kind']) ? { kind: value.kind } : null;
    default:
      return null;
  }
}

export type BankCommandError =
  | 'unknown_command'
  | 'unknown_account'
  | 'unknown_card'
  | 'unknown_rule'
  | 'account_closed'
  | 'account_active'
  | 'checking_only'
  | 'invalid_account'
  | 'duplicate_account'
  | 'duplicate_currency'
  | 'non_zero_balance'
  | 'last_active_account'
  | 'invalid_rule_id'
  | 'duplicate_rule_id'
  | 'invalid_amount'
  | 'invalid_counterparty'
  | 'invalid_note'
  | 'invalid_category'
  | 'invalid_date'
  | 'invalid_display_name'
  | 'amount_too_large'
  | 'too_many_occurrences'
  | 'insufficient_funds'
  | 'capacity'
  | 'balance_overflow'
  | 'invalid_client_transfer_id'
  | 'same_account'
  | 'unknown_target'
  | 'invalid_exchange_rate'
  | 'converted_amount_too_small';

export type BankCommandOutcome =
  | {
      readonly ok: true;
      readonly state: BankState;
      readonly applied: boolean;
      readonly warnings: readonly RecurringWarning[];
      readonly incomingAmountMinor?: Money;
      readonly backfilled?: number;
    }
  | {
      readonly ok: false;
      readonly error: BankCommandError;
      readonly availableMinor?: Money;
      readonly requiredMinor?: Money;
    };

function success(
  state: BankState,
  applied: boolean,
  extra: Omit<Extract<BankCommandOutcome, { ok: true }>, 'ok' | 'state' | 'applied' | 'warnings'> = {},
  warnings: readonly RecurringWarning[] = [],
): BankCommandOutcome {
  return { ok: true, state, applied, warnings, ...extra };
}

export function applyBankCommand(
  state: BankState,
  command: BankCommand,
  context: BankCommandContext,
): BankCommandOutcome {
  const limits = context.limits ?? {};
  switch (command.kind) {
    case 'record_transaction': {
      const outcome = applyManualTransaction(state, {
        ...command,
        nowISO: context.nowISO,
        maxTransactions: limits.maxTransactions,
      });
      return outcome.ok
        ? success(outcome.state, true)
        : { ok: false, error: outcome.error, ...(outcome.availableMinor === undefined ? {} : { availableMinor: outcome.availableMinor }), ...(outcome.requiredMinor === undefined ? {} : { requiredMinor: outcome.requiredMinor }) };
    }
    case 'create_recurring': {
      const outcome = createRecurringRule(state, {
        ...command,
        nowISO: context.nowISO,
        limits,
      });
      return outcome.ok
        ? success(outcome.state, true, { backfilled: outcome.backfilled })
        : { ok: false, error: outcome.error, ...(outcome.availableMinor === undefined ? {} : { availableMinor: outcome.availableMinor }), ...(outcome.requiredMinor === undefined ? {} : { requiredMinor: outcome.requiredMinor }) };
    }
    case 'pause_recurring': {
      const rule = state.recurringRules.find((candidate) => candidate.id === command.ruleId);
      if (!rule) return { ok: false, error: 'unknown_rule' };
      if (rule.status === 'paused' && rule.pauseReason === 'manual') return success(state, false);
      return success({
        ...state,
        recurringRules: state.recurringRules.map((candidate) =>
          candidate.id === rule.id ? { ...candidate, status: 'paused', pauseReason: 'manual' } : candidate,
        ),
      }, true);
    }
    case 'resume_recurring': {
      const rule = state.recurringRules.find((candidate) => candidate.id === command.ruleId);
      if (!rule) return { ok: false, error: 'unknown_rule' };
      const account = state.accounts.find((candidate) => candidate.id === rule.accountId);
      if (!account) return { ok: false, error: 'unknown_account' };
      if (account.status !== 'active') return { ok: false, error: 'account_closed' };
      if (rule.status === 'active') return success(state, false);
      const resumed: BankState = {
        ...state,
        recurringRules: state.recurringRules.map((candidate) =>
          candidate.id === rule.id ? { ...candidate, status: 'active', pauseReason: undefined } : candidate,
        ),
      };
      const materialized = materializeRecurringRules(resumed, context.nowISO, limits);
      return success(materialized.state, true, {}, materialized.warnings);
    }
    case 'add_account': {
      const outcome = applyAddAccount(state, {
        ...command,
        nowISO: context.nowISO,
        maxAccounts: limits.maxAccounts,
        maxTransactions: limits.maxTransactions,
      });
      return outcome.ok ? success(outcome.state, outcome.applied) : outcome;
    }
    case 'adjust_balance': {
      const outcome = applyBalanceAdjustment(state, {
        ...command,
        nowISO: context.nowISO,
        maxTransactions: limits.maxTransactions,
      });
      return outcome.ok ? success(outcome.state, outcome.applied) : outcome;
    }
    case 'close_account': {
      const outcome = applyCloseAccount(state, command.accountId, context.nowISO);
      return outcome.ok ? success(outcome.state, outcome.applied) : outcome;
    }
    case 'restore_account': {
      const outcome = applyRestoreAccount(state, command.accountId, context.nowISO);
      return outcome.ok ? success(outcome.state, outcome.applied) : outcome;
    }
    case 'transfer': {
      const outcome = applyTransfer(state, { ...command.request, nowISO: context.nowISO });
      if (!outcome.ok) return outcome;
      if (outcome.state.transactions.length > (limits.maxTransactions ?? 5_000)) {
        return { ok: false, error: 'capacity' };
      }
      return success(outcome.state, outcome.applied, outcome.incomingAmountMinor === undefined ? {} : { incomingAmountMinor: outcome.incomingAmountMinor });
    }
    case 'set_primary_currency':
      return SUPPORTED_CURRENCIES.includes(command.currency)
        ? success(
            command.currency === state.primaryCurrency
              ? state
              : { ...state, primaryCurrency: command.currency },
            command.currency !== state.primaryCurrency,
          )
        : { ok: false, error: 'unknown_command' };
    case 'set_display_name': {
      const displayName = normalizeUserText(command.displayName, 48);
      if (displayName === null) return { ok: false, error: 'invalid_display_name' };
      if (displayName === state.profile.displayName) return success(state, false);
      return success({ ...state, profile: { ...state.profile, displayName } }, true);
    }
    case 'set_card_frozen': {
      if (typeof command.frozen !== 'boolean') return { ok: false, error: 'unknown_command' };
      const card = state.cards.find((candidate) => candidate.id === command.cardId);
      if (!card) return { ok: false, error: 'unknown_card' };
      const account = state.accounts.find((candidate) => candidate.id === card.accountId);
      if (!command.frozen && account?.status !== 'active') {
        return { ok: false, error: 'account_closed' };
      }
      const desired = command.frozen ? 'frozen' : 'active';
      if (card.status === desired) return success(state, false);
      return success({
        ...state,
        cards: state.cards.map((candidate) =>
          candidate.id === card.id
            ? {
                ...candidate,
                status: desired,
                freezeReason: command.frozen ? 'manual' : undefined,
              }
            : candidate,
        ),
      }, true);
    }
    case 'settle': {
      try {
        const settlement = applySettleAllWithinTransactionLimit(
          state,
          context.nowISO,
          limits.maxTransactions,
        );
        if (settlement.capacityReached) {
          return { ok: false, error: 'capacity' };
        }
        return success(settlement.state, settlement.applied);
      } catch (error: unknown) {
        if (error instanceof RangeError) return { ok: false, error: 'balance_overflow' };
        throw error;
      }
    }
    case 'reset_demo': {
      const reset = rebuildDemoBase(state, state.demoBaseCurrency, context.nowISO);
      return success(
        reset.primaryCurrency === state.primaryCurrency
          ? reset
          : { ...reset, primaryCurrency: state.primaryCurrency },
        true,
      );
    }
    default:
      return { ok: false, error: 'unknown_command' };
  }
}
