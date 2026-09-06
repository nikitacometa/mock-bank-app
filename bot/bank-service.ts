import { canonicalJsonDigest } from './canonical-json.js';
import {
  BankIdempotencyConflictError,
  BankOperationCapacityError,
  BankStateCapacityError,
  BankStateAlreadyExistsError,
  BankStateMissingError,
  type BankOperationSource,
  type PreferencesRepository,
  type StoredBankState,
} from './repository.js';
import { BOT_CURRENCIES, type BotCurrency } from './model.js';
import type { ExchangeRateSnapshot } from '../src/domain/types.js';

export const BANK_CONTRACT_VERSION = 1;
export const BANK_IMPORT_STATE_VERSIONS = [4, 5] as const;

export interface BankDomainFailure {
  readonly code: string;
  readonly availableMinor?: number;
  readonly requiredMinor?: number;
}

export interface BankDomainCommandResult<State> {
  readonly state: State;
  readonly warnings: readonly unknown[];
  readonly outcome: {
    readonly ok: true;
    readonly applied: boolean;
    readonly incomingAmountMinor?: number;
    readonly backfilled?: number;
  };
}

export interface CanonicalBankStateIdentity {
  readonly primaryCurrency: BotCurrency;
  readonly profile: {
    readonly displayName: string;
    readonly telegramId?: string;
  };
}

export interface CanonicalBankPreferences {
  readonly primaryCurrency: BotCurrency;
  readonly displayName: string;
}

export interface BankDeliveryContext {
  readonly accountId: string;
  readonly currency?: BotCurrency;
}

export interface BankDomainAdapter<State extends CanonicalBankStateIdentity, Command> {
  readonly parseState: (
    value: unknown,
    nowISO: string,
    options: { readonly expectedTelegramId: string },
  ) => State | null;
  readonly migrateImport: (
    value: unknown,
    stateVersion: 4 | 5,
    nowISO: string,
    options: { readonly expectedTelegramId: string },
  ) => State | null;
  readonly serializeState: (state: State) => string;
  readonly parseCommand: (value: unknown) => Command | null;
  readonly commandKind: (command: Command) => string;
  readonly applyCommand: (
    state: State,
    command: Command,
    nowISO: string,
  ) => BankDomainCommandResult<State> | BankDomainFailure;
  readonly materialize: (
    state: State,
    nowISO: string,
  ) => { readonly state: State; readonly warnings: readonly unknown[] };
  /**
   * Freezes user-facing warning facts while their matching ledger revision is
   * still available. The durable outbox must not reconstruct them later.
   */
  readonly snapshotWarnings?: (
    state: State,
    warnings: readonly unknown[],
  ) => readonly unknown[];
  /** Server-only seam: clients never provide exchange-rate payloads. */
  readonly replaceExchangeRates?: (
    state: State,
    snapshot: ExchangeRateSnapshot,
    nowISO: string,
  ) => State;
}

export interface BankRateProvider {
  readonly get: () => Promise<ExchangeRateSnapshot>;
}

export interface ServerBankPayload {
  readonly contractVersion: typeof BANK_CONTRACT_VERSION;
  readonly mode: 'server';
  readonly serverTime: string;
  readonly telegramId: string;
  readonly revisionEpoch: string;
  readonly revision: number;
  readonly digest: string;
  readonly state: unknown;
  readonly warnings: readonly unknown[];
}

export interface ImportRequiredBankPayload {
  readonly contractVersion: typeof BANK_CONTRACT_VERSION;
  readonly mode: 'import_required';
  readonly telegramId: string;
}

export type BootstrapBankPayload = ServerBankPayload | ImportRequiredBankPayload;

export interface BankImportResponse extends ServerBankPayload {
  readonly version: 1;
  readonly imported: boolean;
  readonly replayed: boolean;
}

export interface BankCommandResponse extends ServerBankPayload {
  readonly version: 1;
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly operationRevision: number;
  readonly outcome: {
    readonly ok: true;
    readonly applied: boolean;
    readonly incomingAmountMinor?: number;
    readonly backfilled?: number;
  };
}

export interface BankRatesRefreshResponse extends ServerBankPayload {
  readonly version: 1;
  readonly updated: boolean;
}

export class BankServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    status: number,
    code: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(code);
    this.name = 'BankServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isCanonicalTelegramId(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value);
}

function assertCanonicalTelegramId(value: string): void {
  if (!isCanonicalTelegramId(value)) throw new BankServiceError(400, 'invalid_telegram_id');
}

function assertMutationId(value: string, label: string): void {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new BankServiceError(400, label);
}

function assertDeliveryContext(value: BankDeliveryContext): void {
  if (value.accountId.length < 1 || value.accountId.length > 96) {
    throw new BankServiceError(400, 'invalid_delivery_context');
  }
  if (
    value.currency !== undefined &&
    !(BOT_CURRENCIES as readonly string[]).includes(value.currency)
  ) {
    throw new BankServiceError(400, 'invalid_delivery_context');
  }
}

function isDomainFailure<State>(
  value: BankDomainCommandResult<State> | BankDomainFailure,
): value is BankDomainFailure {
  return 'code' in value;
}

function assertWarnings(value: readonly unknown[]): void {
  if (value.length > 64) throw new Error('Too many bank warnings');
}

function recurringWarningKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ruleId !== 'string' || typeof record.reason !== 'string') return null;
  return JSON.stringify([record.ruleId, record.reason]);
}

function mergeWarnings(
  first: readonly unknown[],
  second: readonly unknown[],
): readonly unknown[] {
  const merged: unknown[] = [];
  const recurringKeys = new Set<string>();
  for (const warning of [...first, ...second]) {
    const key = recurringWarningKey(warning);
    if (key !== null) {
      if (recurringKeys.has(key)) continue;
      recurringKeys.add(key);
    }
    merged.push(warning);
  }
  assertWarnings(merged);
  return merged;
}

function mergeWarningContexts(
  mergedWarnings: readonly unknown[],
  firstWarnings: readonly unknown[],
  firstContexts: readonly unknown[] | undefined,
  secondWarnings: readonly unknown[],
  secondContexts: readonly unknown[] | undefined,
): readonly unknown[] | undefined {
  if (firstContexts === undefined || secondContexts === undefined) return undefined;
  if (
    firstContexts.length !== firstWarnings.length ||
    secondContexts.length !== secondWarnings.length
  ) {
    throw new Error('Bank warning context count does not match warnings');
  }

  const contextsByKey = new Map<string, unknown>();
  const unkeyedContexts: unknown[] = [];
  for (const [warnings, contexts] of [
    [firstWarnings, firstContexts],
    [secondWarnings, secondContexts],
  ] as const) {
    warnings.forEach((warning, index) => {
      const key = recurringWarningKey(warning);
      const context = contexts[index];
      if (key === null) {
        unkeyedContexts.push(context);
      } else if (!contextsByKey.has(key)) {
        contextsByKey.set(key, context);
      }
    });
  }

  let unkeyedIndex = 0;
  return mergedWarnings.map((warning) => {
    const key = recurringWarningKey(warning);
    if (key === null) {
      const context = unkeyedContexts[unkeyedIndex];
      unkeyedIndex += 1;
      return context;
    }
    if (!contextsByKey.has(key)) {
      throw new Error('Bank warning context does not match warning');
    }
    return contextsByKey.get(key);
  });
}

function domainFailure(error: BankDomainFailure): BankServiceError {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(error.code)) {
    return new BankServiceError(422, 'invalid_command');
  }
  if (
    (error.availableMinor !== undefined &&
      (!Number.isSafeInteger(error.availableMinor) || error.availableMinor < 0)) ||
    (error.requiredMinor !== undefined &&
      (!Number.isSafeInteger(error.requiredMinor) || error.requiredMinor < 0))
  ) {
    return new BankServiceError(422, 'invalid_command');
  }
  const details: Record<string, number> = {};
  if (error.availableMinor !== undefined) details.availableMinor = error.availableMinor;
  if (error.requiredMinor !== undefined) details.requiredMinor = error.requiredMinor;
  return new BankServiceError(
    422,
    error.code,
    Object.keys(details).length === 0 ? undefined : details,
  );
}

interface StoredOutcome {
  readonly applied: boolean;
  readonly warnings: readonly unknown[];
  readonly incomingAmountMinor?: number;
  readonly backfilled?: number;
  readonly failure?: BankDomainFailure;
}

function parseStoredOutcome(value: unknown): StoredOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid stored bank outcome');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.applied !== 'boolean' || !Array.isArray(record.warnings)) {
    throw new Error('Invalid stored bank outcome');
  }
  assertWarnings(record.warnings);
  if (
    (record.incomingAmountMinor !== undefined &&
      (typeof record.incomingAmountMinor !== 'number' ||
        !Number.isSafeInteger(record.incomingAmountMinor) ||
        record.incomingAmountMinor <= 0)) ||
    (record.backfilled !== undefined &&
      (typeof record.backfilled !== 'number' ||
        !Number.isSafeInteger(record.backfilled) ||
        record.backfilled < 0 ||
        record.backfilled > 120))
  ) {
    throw new Error('Invalid stored bank outcome details');
  }
  let failure: BankDomainFailure | undefined;
  if (record.failure !== undefined) {
    if (typeof record.failure !== 'object' || record.failure === null || Array.isArray(record.failure)) {
      throw new Error('Invalid stored bank failure');
    }
    const candidate = record.failure as Record<string, unknown>;
    if (
      typeof candidate.code !== 'string' ||
      (candidate.availableMinor !== undefined &&
        (typeof candidate.availableMinor !== 'number' || !Number.isSafeInteger(candidate.availableMinor))) ||
      (candidate.requiredMinor !== undefined &&
        (typeof candidate.requiredMinor !== 'number' || !Number.isSafeInteger(candidate.requiredMinor)))
    ) {
      throw new Error('Invalid stored bank failure');
    }
    failure = {
      code: candidate.code,
      ...(candidate.availableMinor === undefined ? {} : { availableMinor: candidate.availableMinor }),
      ...(candidate.requiredMinor === undefined ? {} : { requiredMinor: candidate.requiredMinor }),
    };
  }
  return {
    applied: record.applied,
    warnings: record.warnings,
    ...(record.incomingAmountMinor === undefined
      ? {}
      : { incomingAmountMinor: record.incomingAmountMinor }),
    ...(record.backfilled === undefined ? {} : { backfilled: record.backfilled }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export class BankAuthorityService<State extends CanonicalBankStateIdentity, Command> {
  readonly #repository: PreferencesRepository;
  readonly #domain: BankDomainAdapter<State, Command>;
  readonly #clock: () => Date;
  readonly #rateProvider: BankRateProvider | undefined;

  constructor(
    repository: PreferencesRepository,
    domain: BankDomainAdapter<State, Command>,
    clock: () => Date = () => new Date(),
    rateProvider?: BankRateProvider,
  ) {
    this.#repository = repository;
    this.#domain = domain;
    this.#clock = clock;
    this.#rateProvider = rateProvider;
  }

  bootstrap(telegramUserId: string): BootstrapBankPayload | null {
    assertCanonicalTelegramId(telegramUserId);
    if (this.#repository.ledgerMode() === 'local') return null;
    const stored = this.#repository.getBankState(telegramUserId);
    if (stored === null) {
      return {
        contractVersion: BANK_CONTRACT_VERSION,
        mode: 'import_required',
        telegramId: telegramUserId,
      };
    }
    const nowISO = this.#nowISO();
    let materialized;
    try {
      materialized = this.#repository.mutateBankState(telegramUserId, (rawState) => {
        const state = this.#parseStoredState(rawState, telegramUserId, nowISO);
        const result = this.#domain.materialize(state, nowISO);
        assertWarnings(result.warnings);
        const validated = this.#validateTransitionState(result.state, telegramUserId, nowISO);
        const warningContexts = this.#snapshotWarnings(validated.state, result.warnings);
        return {
          stateJson: validated.stateJson,
          outcome: { warnings: result.warnings },
          ...(result.warnings.length === 0
            ? {}
            : {
                outbox: {
                  messageKind: 'bank_materialization_warning',
                  payload: {
                    warnings: result.warnings,
                    ...(warningContexts === undefined ? {} : { warningContexts }),
                  },
                },
              }),
        };
      });
    } catch (error) {
      if (error instanceof BankStateCapacityError) {
        const canonical = this.#parseStoredState(stored.state, telegramUserId, nowISO);
        return this.#serverPayload(
          telegramUserId,
          { ...stored, state: canonical },
          [],
          nowISO,
        );
      }
      throw error;
    }
    const outcome = materialized.outcome as { readonly warnings?: unknown };
    if (!Array.isArray(outcome.warnings)) throw new Error('Invalid materialization outcome');
    return this.#serverPayload(telegramUserId, materialized.state, outcome.warnings, nowISO);
  }

  importState(input: {
    readonly telegramUserId: string;
    readonly importId: string;
    readonly stateVersion: 4 | 5;
    readonly rawState: unknown;
  }): BankImportResponse {
    assertCanonicalTelegramId(input.telegramUserId);
    this.#requireServerMode();
    assertMutationId(input.importId, 'invalid_import_id');
    if (!(BANK_IMPORT_STATE_VERSIONS as readonly number[]).includes(input.stateVersion)) {
      throw new BankServiceError(400, 'invalid_state_version');
    }
    let commandHash: string;
    try {
      commandHash = canonicalJsonDigest({
        version: 1,
        stateVersion: input.stateVersion,
        state: input.rawState,
      });
    } catch {
      throw new BankServiceError(422, 'invalid_bank_state');
    }
    const nowISO = this.#nowISO();
    try {
      const replay = this.#repository.replayBankOperation(
        input.telegramUserId,
        'import',
        input.importId,
        commandHash,
      );
      if (replay !== null) return this.#importResponse(input.telegramUserId, replay, nowISO);
      const state = this.#domain.migrateImport(
        input.rawState,
        input.stateVersion,
        nowISO,
        { expectedTelegramId: input.telegramUserId },
      );
      if (state === null) throw new BankServiceError(422, 'invalid_bank_state');
      const imported = this.#repository.importBankState({
        telegramUserId: input.telegramUserId,
        operationId: input.importId,
        commandHash,
        stateJson: this.#domain.serializeState(state),
        outcome: { applied: true, warnings: [] },
      });
      return this.#importResponse(input.telegramUserId, imported, nowISO);
    } catch (error) {
      if (error instanceof BankIdempotencyConflictError) {
        throw new BankServiceError(409, 'idempotency_conflict');
      }
      if (error instanceof BankOperationCapacityError) {
        throw new BankServiceError(409, 'operation_capacity');
      }
      if (error instanceof BankStateCapacityError) {
        throw new BankServiceError(413, 'bank_state_too_large');
      }
      if (error instanceof BankStateAlreadyExistsError) {
        throw new BankServiceError(409, 'bank_already_exists');
      }
      throw error;
    }
  }

  executeCommand(input: {
    readonly telegramUserId: string;
    readonly sourceKind: Exclude<BankOperationSource, 'import' | 'system'>;
    readonly operationId: string;
    readonly rawCommand: unknown;
    readonly chatId?: string;
    readonly deliveryContext?: BankDeliveryContext;
  }): BankCommandResponse {
    assertCanonicalTelegramId(input.telegramUserId);
    this.#requireServerMode();
    if (input.sourceKind !== 'tma' && input.sourceKind !== 'telegram') {
      throw new BankServiceError(400, 'invalid_operation_source');
    }
    if (input.sourceKind === 'tma') {
      assertMutationId(input.operationId, 'invalid_client_mutation_id');
      if (input.chatId !== undefined || input.deliveryContext !== undefined) {
        throw new BankServiceError(400, 'unexpected_delivery_context');
      }
    } else if (!/^\d{1,16}$/.test(input.operationId)) {
      throw new BankServiceError(400, 'invalid_update_id');
    } else if (input.chatId !== input.telegramUserId) {
      throw new BankServiceError(400, 'invalid_chat_id');
    }
    if (input.deliveryContext !== undefined) assertDeliveryContext(input.deliveryContext);
    let commandHash: string;
    try {
      commandHash = canonicalJsonDigest({ version: 1, command: input.rawCommand });
    } catch {
      throw new BankServiceError(422, 'invalid_command');
    }
    const nowISO = this.#nowISO();
    try {
      const replay = this.#repository.replayBankOperation(
        input.telegramUserId,
        input.sourceKind,
        input.operationId,
        commandHash,
      );
      if (replay !== null) return this.#commandResponse(input.telegramUserId, replay, nowISO);
      const command = this.#domain.parseCommand(input.rawCommand);
      if (command === null) throw new BankServiceError(422, 'invalid_command');
      const operationKind = this.#domain.commandKind(command);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(operationKind)) {
        throw new Error('Invalid domain command kind');
      }
      const executed = this.#repository.executeBankOperation({
        telegramUserId: input.telegramUserId,
        sourceKind: input.sourceKind,
        operationId: input.operationId,
        commandHash,
        operationKind,
        chatId: input.sourceKind === 'tma' ? input.telegramUserId : input.chatId,
      }, (rawState) => {
        const state = this.#parseStoredState(rawState, input.telegramUserId, nowISO);
        const validatedBefore = this.#validateTransitionState(
          state,
          input.telegramUserId,
          nowISO,
        );
        const due = operationKind === 'reset_demo'
          ? { state: validatedBefore.state, warnings: [] }
          : this.#domain.materialize(validatedBefore.state, nowISO);
        assertWarnings(due.warnings);
        const validatedDue = this.#validateTransitionState(
          due.state,
          input.telegramUserId,
          nowISO,
        );
        const dueWarningContexts = this.#snapshotWarnings(
          validatedDue.state,
          due.warnings,
        );
        const result = this.#domain.applyCommand(validatedDue.state, command, nowISO);
        if (isDomainFailure(result)) {
          const failure = domainFailure(result);
          const storedFailure: BankDomainFailure = {
            code: failure.code,
            ...(failure.details?.availableMinor === undefined
              ? {}
              : { availableMinor: failure.details.availableMinor as number }),
            ...(failure.details?.requiredMinor === undefined
              ? {}
              : { requiredMinor: failure.details.requiredMinor as number }),
          };
          const outcome: StoredOutcome = {
            applied: false,
            // A rejected command cannot advance a canonical ledger without
            // returning that revision to the TMA client. Materialization is
            // retried on the next bootstrap instead.
            warnings: [],
            failure: storedFailure,
          };
          parseStoredOutcome(outcome);
          return {
            stateJson: validatedBefore.stateJson,
            outcome,
            ...(input.sourceKind === 'telegram'
              ? {
                  outbox: {
                    messageKind: 'bank_operation_result',
                    payload: {
                      operationKind,
                      ...outcome,
                      ...(input.deliveryContext === undefined
                        ? {}
                        : { deliveryContext: input.deliveryContext }),
                    },
                  },
                }
            : {}),
          };
        }
        const validatedResult = this.#validateTransitionState(
          result.state,
          input.telegramUserId,
          nowISO,
        );
        const resultWarningContexts = this.#snapshotWarnings(
          validatedResult.state,
          result.warnings,
        );
        const warnings = mergeWarnings(due.warnings, result.warnings);
        const warningContexts = mergeWarningContexts(
          warnings,
          due.warnings,
          dueWarningContexts,
          result.warnings,
          resultWarningContexts,
        );
        const outcome: StoredOutcome = {
          applied: result.outcome.applied,
          warnings,
          ...(result.outcome.incomingAmountMinor === undefined
            ? {}
            : { incomingAmountMinor: result.outcome.incomingAmountMinor }),
          ...(result.outcome.backfilled === undefined
            ? {}
            : { backfilled: result.outcome.backfilled }),
        };
        parseStoredOutcome(outcome);
        return {
          stateJson: validatedResult.stateJson,
          outcome,
          ...(input.sourceKind === 'telegram'
            ? {
                outbox: {
                  messageKind: 'bank_operation_result',
                    payload: {
                      operationKind,
                      ...outcome,
                      ...(warningContexts === undefined ? {} : { warningContexts }),
                      ...(input.deliveryContext === undefined
                        ? {}
                        : { deliveryContext: input.deliveryContext }),
                  },
                },
              }
            : warnings.length === 0
              ? {}
              : {
                  outbox: {
                    messageKind: 'bank_materialization_warning',
                    payload: {
                      warnings,
                      ...(warningContexts === undefined ? {} : { warningContexts }),
                    },
                  },
                }),
        };
      });
      return this.#commandResponse(input.telegramUserId, executed, nowISO);
    } catch (error) {
      if (error instanceof BankServiceError) throw error;
      if (error instanceof BankIdempotencyConflictError) {
        throw new BankServiceError(409, 'idempotency_conflict');
      }
      if (error instanceof BankOperationCapacityError) {
        throw new BankServiceError(409, 'operation_capacity');
      }
      if (error instanceof BankStateCapacityError) {
        throw new BankServiceError(413, 'bank_state_too_large');
      }
      if (error instanceof BankStateMissingError) {
        throw new BankServiceError(409, 'bank_import_required');
      }
      throw error;
    }
  }

  async refreshRates(telegramUserId: string): Promise<BankRatesRefreshResponse> {
    assertCanonicalTelegramId(telegramUserId);
    this.#requireServerMode();
    if (this.#repository.getBankState(telegramUserId) === null) {
      throw new BankServiceError(409, 'bank_import_required');
    }
    const replaceExchangeRates = this.#domain.replaceExchangeRates;
    const provider = this.#rateProvider;
    if (replaceExchangeRates === undefined || provider === undefined) {
      throw new BankServiceError(503, 'bank_rates_unavailable');
    }

    let snapshot: ExchangeRateSnapshot;
    try {
      snapshot = await provider.get();
    } catch {
      // Provider details are deliberately not reflected through the public API.
      throw new BankServiceError(503, 'bank_rates_unavailable');
    }

    const nowISO = this.#nowISO();
    try {
      const mutation = this.#repository.mutateBankState(telegramUserId, (rawState) => {
        const state = this.#parseStoredState(rawState, telegramUserId, nowISO);
        const currentJson = this.#domain.serializeState(state);
        const replaced = replaceExchangeRates(state, snapshot, nowISO);
        const validated = this.#validateTransitionState(replaced, telegramUserId, nowISO);
        return {
          stateJson: validated.stateJson,
          outcome: { updated: validated.stateJson !== currentJson },
        };
      });
      const outcome = mutation.outcome as { readonly updated?: unknown };
      if (typeof outcome.updated !== 'boolean') {
        throw new Error('Invalid bank rate refresh outcome');
      }
      return {
        version: 1,
        ...this.#serverPayload(telegramUserId, mutation.state, [], nowISO),
        updated: outcome.updated,
      };
    } catch (error) {
      if (error instanceof BankOperationCapacityError) {
        throw new BankServiceError(409, 'operation_capacity');
      }
      if (error instanceof BankStateCapacityError) {
        throw new BankServiceError(413, 'bank_state_too_large');
      }
      if (error instanceof BankStateMissingError) {
        throw new BankServiceError(409, 'bank_import_required');
      }
      throw error;
    }
  }

  materialize(telegramUserId: string): ServerBankPayload {
    const result = this.bootstrap(telegramUserId);
    if (result === null) throw new BankServiceError(503, 'bank_authority_disabled');
    if (result.mode === 'import_required') throw new BankServiceError(409, 'bank_import_required');
    return result;
  }

  preferencesForBank(payload: ServerBankPayload): CanonicalBankPreferences {
    const state = this.#parseStoredState(payload.state, payload.telegramId, payload.serverTime);
    return {
      primaryCurrency: state.primaryCurrency,
      displayName: state.profile.displayName,
    };
  }

  #parseStoredState(raw: unknown, telegramUserId: string, nowISO: string): State {
    const state = this.#domain.parseState(raw, nowISO, { expectedTelegramId: telegramUserId });
    if (state === null) throw new Error('Stored bank state failed validation');
    return state;
  }

  #validateTransitionState(
    raw: unknown,
    telegramUserId: string,
    nowISO: string,
  ): { readonly state: State; readonly stateJson: string } {
    const state = this.#domain.parseState(raw, nowISO, {
      expectedTelegramId: telegramUserId,
    });
    if (state === null) throw new Error('Domain produced invalid bank state');

    const stateJson = this.#domain.serializeState(state);
    let serializedState: unknown;
    try {
      serializedState = JSON.parse(stateJson) as unknown;
    } catch (error) {
      throw new Error('Domain produced invalid serialized bank state', { cause: error });
    }
    const roundTrip = this.#domain.parseState(serializedState, nowISO, {
      expectedTelegramId: telegramUserId,
    });
    if (roundTrip === null || this.#domain.serializeState(roundTrip) !== stateJson) {
      throw new Error('Domain produced invalid serialized bank state');
    }
    return { state: roundTrip, stateJson };
  }

  #importResponse(
    telegramUserId: string,
    imported: ReturnType<PreferencesRepository['importBankState']>,
    nowISO: string,
  ): BankImportResponse {
    const canonical = this.#parseStoredState(imported.state.state, telegramUserId, nowISO);
    return {
      version: 1,
      ...this.#serverPayload(telegramUserId, { ...imported.state, state: canonical }, [], nowISO),
      imported: !imported.replayed,
      replayed: imported.replayed,
    };
  }

  #commandResponse(
    telegramUserId: string,
    executed: ReturnType<PreferencesRepository['executeBankOperation']>,
    nowISO: string,
  ): BankCommandResponse {
    const canonical = this.#parseStoredState(executed.state.state, telegramUserId, nowISO);
    const outcome = parseStoredOutcome(executed.outcome);
    if (outcome.failure !== undefined) throw domainFailure(outcome.failure);
    return {
      version: 1,
      ...this.#serverPayload(
        telegramUserId,
        { ...executed.state, state: canonical },
        outcome.warnings,
        nowISO,
      ),
      applied: outcome.applied,
      replayed: executed.replayed,
      operationRevision: executed.operationRevision,
      outcome: {
        ok: true,
        applied: outcome.applied,
        ...(outcome.incomingAmountMinor === undefined
          ? {}
          : { incomingAmountMinor: outcome.incomingAmountMinor }),
        ...(outcome.backfilled === undefined ? {} : { backfilled: outcome.backfilled }),
      },
    };
  }

  #serverPayload(
    telegramUserId: string,
    state: StoredBankState,
    warnings: readonly unknown[],
    serverTime: string,
  ): ServerBankPayload {
    assertWarnings(warnings);
    return {
      contractVersion: BANK_CONTRACT_VERSION,
      mode: 'server',
      serverTime,
      telegramId: telegramUserId,
      revisionEpoch: this.#repository.revisionEpoch(),
      revision: state.revision,
      digest: state.digest,
      state: state.state,
      warnings,
    };
  }

  #snapshotWarnings(
    state: State,
    warnings: readonly unknown[],
  ): readonly unknown[] | undefined {
    const snapshotWarnings = this.#domain.snapshotWarnings;
    if (snapshotWarnings === undefined) return undefined;
    const contexts = snapshotWarnings(state, warnings);
    if (contexts.length !== warnings.length || contexts.length > 64) {
      throw new Error('Bank warning context count does not match warnings');
    }
    return contexts;
  }

  #requireServerMode(): void {
    if (this.#repository.ledgerMode() !== 'server') {
      throw new BankServiceError(503, 'bank_authority_disabled');
    }
  }

  #nowISO(): string {
    const value = this.#clock();
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds)) throw new Error('Invalid bank service clock');
    return value.toISOString();
  }
}
