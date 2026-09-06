import {
  applyBankCommand,
  parseBankCommand,
  type BankCommand,
} from '../src/domain/bankCommands.js';
import {
  canonicalBankStateJson,
  migrateBankStateV4,
  parseBankState,
} from '../src/domain/bankState.js';
import { applySettleAllWithinTransactionLimit } from '../src/domain/interest.js';
import { assertLedger } from '../src/domain/invariants.js';
import { materializeRecurringRules } from '../src/domain/recurring.js';
import type { BankState, Currency } from '../src/domain/types.js';
import { shouldAdoptExchangeRateSnapshot } from '../src/services/exchangeRates.js';
import type {
  BankDomainAdapter,
  BankDomainCommandResult,
  BankDomainFailure,
} from './bank-service.js';

const MAX_RECURRING_WARNING_CONTEXTS = 64;
const RECURRING_WARNING_REASONS = new Set([
  'capacity',
  'overflow',
  'insufficient_funds',
] as const);

export interface RecurringWarningDeliveryContext {
  readonly ruleId: string;
  readonly reason: 'capacity' | 'overflow' | 'insufficient_funds';
  readonly counterparty: string;
  readonly currency: Currency;
  readonly availableMinor?: number;
  readonly requiredMinor?: number;
}

function warningAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Freezes the user-facing facts of a recurring warning while the matching
 * canonical state is still available. Delayed outbox delivery must never
 * reconstruct these facts from a later ledger revision.
 */
export function snapshotRecurringWarningContexts(
  state: BankState,
  warnings: readonly unknown[],
): readonly RecurringWarningDeliveryContext[] {
  if (warnings.length > MAX_RECURRING_WARNING_CONTEXTS) {
    throw new RangeError('Too many recurring warnings');
  }
  const contexts = warnings.map((warning): RecurringWarningDeliveryContext => {
    if (
      typeof warning !== 'object' ||
      warning === null ||
      Array.isArray(warning)
    ) {
      throw new TypeError('Invalid recurring warning');
    }
    const candidate = warning as Record<string, unknown>;
    if (
      typeof candidate.ruleId !== 'string' ||
      typeof candidate.reason !== 'string' ||
      !RECURRING_WARNING_REASONS.has(
        candidate.reason as RecurringWarningDeliveryContext['reason'],
      )
    ) {
      throw new TypeError('Invalid recurring warning');
    }
    const reason = candidate.reason as RecurringWarningDeliveryContext['reason'];
    const rule = state.recurringRules.find((item) => item.id === candidate.ruleId);
    const account = rule === undefined
      ? undefined
      : state.accounts.find((item) => item.id === rule.accountId);
    if (rule === undefined || account === undefined) {
      throw new TypeError('Recurring warning has no canonical context');
    }
    if (
      reason === 'insufficient_funds' &&
      (!warningAmount(candidate.availableMinor) || !warningAmount(candidate.requiredMinor))
    ) {
      throw new TypeError('Recurring warning has invalid money context');
    }
    return Object.freeze({
      ruleId: candidate.ruleId,
      reason,
      counterparty: rule.counterparty,
      currency: account.currency,
      ...(reason === 'insufficient_funds'
        ? {
            availableMinor: candidate.availableMinor as number,
            requiredMinor: candidate.requiredMinor as number,
          }
        : {}),
    });
  });
  return Object.freeze(contexts);
}

/**
 * Advances every time-derived ledger concern in its canonical order.
 * Interest settles first so any recurring rows always receive later sequence
 * numbers, and repeated reads on the same UTC day remain exact no-ops.
 */
export function materializeBankState(
  state: BankState,
  nowISO: string,
): ReturnType<typeof materializeRecurringRules> {
  const settlement = applySettleAllWithinTransactionLimit(state, nowISO);
  const result = materializeRecurringRules(
    settlement.state,
    nowISO,
    // If the complete interest batch does not fit, recurring rows must not
    // consume the remaining slots and make that deferred batch impossible.
    settlement.capacityReached
      ? { maxTransactions: state.transactions.length }
      : {},
  );
  assertLedger(result.state);
  return result;
}

export const bankDomainAdapter: BankDomainAdapter<BankState, BankCommand> & {
  readonly snapshotWarnings: typeof snapshotRecurringWarningContexts;
} = {
  parseState: parseBankState,
  migrateImport(value, stateVersion, nowISO, options) {
    return stateVersion === 4
      ? migrateBankStateV4(value, nowISO, options)
      : parseBankState(value, nowISO, options);
  },
  serializeState: canonicalBankStateJson,
  parseCommand: parseBankCommand,
  commandKind: (command) => command.kind,
  applyCommand(state, command, nowISO): BankDomainCommandResult<BankState> | BankDomainFailure {
    const outcome = applyBankCommand(state, command, { nowISO });
    if (!outcome.ok) {
      return {
        code: outcome.error,
        ...(outcome.availableMinor === undefined
          ? {}
          : { availableMinor: outcome.availableMinor }),
        ...(outcome.requiredMinor === undefined
          ? {}
          : { requiredMinor: outcome.requiredMinor }),
      };
    }
    return {
      state: outcome.state,
      warnings: outcome.warnings,
      outcome: {
        ok: true,
        applied: outcome.applied,
        ...(outcome.incomingAmountMinor === undefined
          ? {}
          : { incomingAmountMinor: outcome.incomingAmountMinor }),
        ...(outcome.backfilled === undefined ? {} : { backfilled: outcome.backfilled }),
      },
    };
  },
  materialize: materializeBankState,
  snapshotWarnings: snapshotRecurringWarningContexts,
  replaceExchangeRates(state, snapshot, nowISO) {
    return shouldAdoptExchangeRateSnapshot(
      state.exchangeRates,
      snapshot,
      Date.parse(nowISO),
    )
      ? { ...state, exchangeRates: snapshot }
      : state;
  },
};
