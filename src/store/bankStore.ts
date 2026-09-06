import { create } from 'zustand';
import type { BankState, Currency, ExchangeRateSnapshot } from '@/domain/types';
import { applyBankCommand, type BankCommand, type BankCommandOutcome } from '@/domain/bankCommands';
import type {
  LaunchBankState,
  LaunchPreferences,
  PlatformAdapter,
  ServerBankRevision,
} from '@/platform/types';
import { createClientMutationId } from '@/platform/clientMutationId';
import { canonicalBankStateJson } from '@/domain/bankState';
import {
  advanceLedgerAuthorityReceipt,
  classifyLedgerAuthorityRevision,
  hasStickyServerLedgerMode,
  loadLedgerAuthorityReceipt,
  markStickyServerLedgerMode,
  saveLedgerAuthorityReceipt,
} from '@/platform/ledgerAuthorityReceipt';
import { TelegramApiRequestError } from '@/platform/bankApi';
import {
  type TransferError,
  type TransferOutcome,
  type TransferRequest,
} from '@/domain/transfer';
import { applySettleAllWithinTransactionLimit } from '@/domain/interest';
import { utcDate } from '@/domain/inputValidation';
import { buildSeed, rebuildDemoBase } from '@/domain/seed';
import { assertLedger } from '@/domain/invariants';
import { fetchExchangeRates, isRateSnapshotDateCoherent } from '@/services/exchangeRates';
import {
  activateTelegramPersistence,
  getActivePersistenceScope,
  getActiveTelegramPersistenceId,
  isTelegramPersistenceRuntime,
  loadPersisted,
  savePersisted,
  SCHEMA_VERSION,
  onCrossTabChange,
  quarantineTelegramPersistence,
  withPersistenceLock,
} from './persistence';
import { reconcileUiAfterBankStateChange, useUiStore } from './uiStore';

export type RatesStatus = 'idle' | 'loading' | 'fresh' | 'error';
export type RatesRefreshResult = 'updated' | 'cached' | 'failed';
export type LedgerMode = 'local' | 'server' | 'read_only';
export type TelegramBankSyncResult = 'local' | 'current' | 'applied' | 'retry';

export class ServerLedgerReadOnlyError extends Error {
  constructor() {
    super('Server ledger is temporarily read-only');
    this.name = 'ServerLedgerReadOnlyError';
  }
}

const LIVE_RATE_CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface RatesRequest {
  readonly generation: number;
  readonly promise: Promise<ExchangeRateSnapshot>;
}

let ratesRequest: RatesRequest | null = null;
let latestRatesRequestGeneration = 0;
let persistenceDirtyScope: string | null = null;
let serverAdoptionQueue: Promise<void> = Promise.resolve();
// Ephemeral only: distinguishes a genuinely empty verified namespace from an
// existing v4/v5 snapshot that must keep its original fixture.
let freshTelegramPersistenceId: string | null = null;
// An existing pre-authority device snapshot is preserved until the user
// explicitly accepts the already-canonical server copy.
let unconfirmedLocalSnapshotId: string | null = null;
let approvedServerCopyId: string | null = null;
interface ServerGateway {
  readonly telegramId: string;
  readonly execute: PlatformAdapter['executeBankCommand'];
  readonly refreshRates: PlatformAdapter['refreshBankRates'];
}

interface ServerSettlementRequest {
  readonly telegramId: string;
  readonly promise: Promise<void>;
}

let serverGateway: ServerGateway | null = null;
let serverSettlementRequest: ServerSettlementRequest | null = null;

/**
 * Mirrors the two server materializers without speculatively mutating state.
 * A zero-balance savings account is still due because its anchor must advance.
 */
function needsServerMaterialization(state: BankState, nowISO: string): boolean {
  const today = utcDate(nowISO);
  const savingsSettlement = applySettleAllWithinTransactionLimit(state, nowISO);
  // A positive-interest batch that cannot fit is deferred atomically by the
  // server. Sending a fresh command cannot advance its anchors or recurrence;
  // it can only consume rate-limit and replay-window capacity with a 422.
  if (savingsSettlement.capacityReached) return false;
  if (savingsSettlement.applied) return true;

  const activeCheckingIds = new Set(
    state.accounts
      .filter((account) => account.type === 'checking' && account.status === 'active')
      .map((account) => account.id),
  );
  return state.recurringRules.some(
    (rule) =>
      rule.status === 'active' &&
      activeCheckingIds.has(rule.accountId) &&
      rule.nextOccurrence <= today,
  );
}

function isFreshLiveSnapshot(snapshot: ExchangeRateSnapshot, now = Date.now()): boolean {
  if (snapshot.source !== 'frankfurter') return false;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const age = now - fetchedAt;
  return (
    Number.isFinite(fetchedAt) &&
    isRateSnapshotDateCoherent(snapshot.asOf, snapshot.fetchedAt) &&
    age >= -5 * 60 * 1000 &&
    age < LIVE_RATE_CACHE_MS
  );
}

function deriveRatesStatusAfterAdoption(
  localStatus: RatesStatus,
  adoptedSnapshot: ExchangeRateSnapshot,
): RatesStatus {
  if (localStatus === 'loading') return 'loading';
  if (isFreshLiveSnapshot(adoptedSnapshot)) return 'fresh';
  return localStatus === 'error' ? 'error' : 'idle';
}

function getOrStartRatesRequest(): RatesRequest {
  if (ratesRequest !== null) return ratesRequest;

  const request: RatesRequest = {
    generation: latestRatesRequestGeneration + 1,
    promise: fetchExchangeRates(),
  };
  latestRatesRequestGeneration = request.generation;
  ratesRequest = request;
  const clearIfCurrent = () => {
    if (ratesRequest === request) ratesRequest = null;
  };
  // Handle both outcomes on the original promise: an ignored `.finally()` child
  // would create an unhandled rejection when every refresh caller catches failure.
  void request.promise.then(clearIfCurrent, clearIfCurrent);
  return request;
}

interface BankStore extends BankState {
  /** True when persisted state failed validation and was reseeded. */
  recoveredFromCorruption: boolean;
  ratesStatus: RatesStatus;
  ledgerMode: LedgerMode;
  ledgerSyncError: string | null;

  transfer(input: TransferRequest): Promise<TransferOutcome>;
  setPrimaryCurrency(currency: Currency): Promise<void>;
  applyLaunchPreferences(
    preferences: LaunchPreferences,
    signal?: AbortSignal,
  ): Promise<boolean>;
  isolateTelegramSession(telegramId: string | undefined, signal?: AbortSignal): Promise<boolean>;
  activateVerifiedTelegramSession(telegramId: string, signal?: AbortSignal): Promise<boolean>;
  synchronizeTelegramBank(
    telegramId: string,
    bank: LaunchBankState | undefined,
    platform: PlatformAdapter,
    signal: AbortSignal,
  ): Promise<TelegramBankSyncResult>;
  approveServerCopy(): boolean;
  refreshRates(force?: boolean): Promise<RatesRefreshResult>;
  settleNow(): Promise<void>;
  toggleCardFreeze(cardId: string): Promise<void>;
  resetDemo(): Promise<void>;
}

function pickBankState(state: BankState): BankState {
  return {
    primaryCurrency: state.primaryCurrency,
    demoBaseCurrency: state.demoBaseCurrency,
    fixtureId: state.fixtureId,
    exchangeRates: state.exchangeRates,
    accounts: state.accounts,
    transactions: state.transactions,
    cards: state.cards,
    contacts: state.contacts,
    profile: state.profile,
    nextSeq: state.nextSeq,
    recentTransferIds: state.recentTransferIds,
    recurringRules: state.recurringRules,
  };
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

async function enqueueServerAdoption<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  let release: VoidFunction = () => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = serverAdoptionQueue;
  serverAdoptionQueue = previous.then(() => turn, () => turn);
  try {
    await previous;
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
  }
}

const TRANSFER_ERRORS = new Set([
  'invalid_amount',
  'amount_too_large',
  'invalid_client_transfer_id',
  'insufficient_funds',
  'same_account',
  'unknown_target',
  'invalid_exchange_rate',
  'converted_amount_too_small',
  'capacity',
  'balance_overflow',
  'account_closed',
]);

function isCurrentPersistenceDirty(): boolean {
  return persistenceDirtyScope === getActivePersistenceScope();
}

function handleInitialPersistenceFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  console.error('[cometa] initial persistence synchronization failed', error);
}

function isNewerLiveSnapshot(
  current: ExchangeRateSnapshot,
  candidate: ExchangeRateSnapshot,
  now = Date.now(),
): boolean {
  if (current.source !== 'frankfurter') return false;
  const currentFetchedAt = Date.parse(current.fetchedAt);
  if (
    !Number.isFinite(currentFetchedAt) ||
    !isRateSnapshotDateCoherent(current.asOf, current.fetchedAt) ||
    currentFetchedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return false;
  }
  if (current.asOf !== candidate.asOf) return current.asOf > candidate.asOf;
  return currentFetchedAt > Date.parse(candidate.fetchedAt);
}

function hasRateSnapshotVersionChanged(
  before: ExchangeRateSnapshot,
  current: ExchangeRateSnapshot,
): boolean {
  return (
    before.source !== current.source ||
    before.asOf !== current.asOf ||
    before.fetchedAt !== current.fetchedAt
  );
}

function initialState(): { state: BankState; recovered: boolean } {
  const loaded = loadPersisted();
  if (loaded.kind === 'ok') return { state: loaded.state, recovered: false };
  return { state: buildSeed(new Date().toISOString()), recovered: loaded.kind === 'corrupted' };
}

const init = initialState();

function reconcilePersistenceScopeChange(previousScope: string): void {
  if (previousScope === getActivePersistenceScope()) return;
  const ui = useUiStore.getState();
  ui.reloadLocalePreference();
  ui.resetUi();
}

export const useBankStore = create<BankStore>()((set, get) => {
  const adopt = (next: BankState) => {
    const previous = pickBankState(get());
    set({
      ...next,
      ratesStatus: deriveRatesStatusAfterAdoption(get().ratesStatus, next.exchangeRates),
    });
    reconcileUiAfterBankStateChange(previous, next);
  };

  /** Apply a BankState transition atomically + persist + dev-invariant. */
  const commit = (next: BankState): boolean => {
    assertLedger(next);
    adopt(next);
    const saved = savePersisted(next);
    persistenceDirtyScope = saved ? null : getActivePersistenceScope();
    return saved;
  };

  const readMutationBase = (): BankState => {
    if (isCurrentPersistenceDirty()) return pickBankState(get());
    const persisted = loadPersisted();
    return persisted.kind === 'ok' ? persisted.state : pickBankState(get());
  };

  const quarantineChangedTelegramSession = (): void => {
    if (!isTelegramPersistenceRuntime()) return;
    const previousScope = getActivePersistenceScope();
    const visible = pickBankState(get());
    serverGateway = null;
    freshTelegramPersistenceId = null;
    unconfirmedLocalSnapshotId = null;
    approvedServerCopyId = null;
    quarantineTelegramPersistence();
    persistenceDirtyScope = null;
    const seeded = buildSeed(new Date().toISOString());
    const isolated = {
      ...seeded,
      exchangeRates:
        visible.exchangeRates.source === 'frankfurter'
          ? visible.exchangeRates
          : seeded.exchangeRates,
    };
    assertLedger(isolated);
    adopt(isolated);
    set({
      ledgerMode: 'read_only',
      ledgerSyncError: 'telegram_session_changed',
      recoveredFromCorruption: false,
    });
    reconcilePersistenceScopeChange(previousScope);
  };

  const handleServerRequestFailure = (error: unknown): void => {
    if (
      error instanceof TelegramApiRequestError &&
      error.code === 'telegram_session_changed'
    ) {
      quarantineChangedTelegramSession();
      return;
    }
    set({
      ledgerSyncError:
        error instanceof TelegramApiRequestError ? error.code : 'request_failed',
    });
  };

  const adoptServerRevision = async (
    candidate: ServerBankRevision,
    signal?: AbortSignal,
  ): Promise<'applied' | 'current' | 'stale' | 'retired' | 'retry'> =>
    enqueueServerAdoption(signal, () =>
      withPersistenceLock(() => {
        signal?.throwIfAborted();
        if (
          !isTelegramPersistenceRuntime() ||
          getActiveTelegramPersistenceId() !== candidate.telegramId
        ) {
          serverGateway = null;
          set({ ledgerMode: 'read_only', ledgerSyncError: 'telegram_session_changed' });
          throw abortError('Telegram persistence namespace changed');
        }

        const currentReceipt = loadLedgerAuthorityReceipt(candidate.telegramId);
        const decision = classifyLedgerAuthorityRevision(currentReceipt, candidate);
        if (decision === 'wrong_user') {
          serverGateway = null;
          set({ ledgerMode: 'read_only', ledgerSyncError: 'wrong_user' });
          throw abortError('Server ledger belongs to another Telegram user');
        }
        if (decision === 'digest_conflict') {
          serverGateway = null;
          set({ ledgerMode: 'read_only', ledgerSyncError: 'digest_conflict' });
          return 'retry';
        }
        if (decision === 'retired_epoch') return 'retired';
        if (decision === 'stale') return 'stale';

        const localSnapshotNeedsConfirmation =
          currentReceipt === null &&
          unconfirmedLocalSnapshotId === candidate.telegramId &&
          approvedServerCopyId !== candidate.telegramId &&
          canonicalBankStateJson(pickBankState(get())) !==
            canonicalBankStateJson(candidate.state);
        if (localSnapshotNeedsConfirmation) {
          serverGateway = null;
          set({
            ledgerMode: 'read_only',
            ledgerSyncError: 'server_copy_confirmation_required',
          });
          return 'retry';
        }

        const nextReceipt = advanceLedgerAuthorityReceipt(currentReceipt, candidate);
        if (nextReceipt === null) return 'retry';
        // Fail closed before exposing a canonical server state. If the tab dies
        // after this marker, the next launch requires the authority API instead
        // of silently reopening a client-local write path.
        if (!markStickyServerLedgerMode(candidate.telegramId)) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'receipt_persistence_failed' });
          return 'retry';
        }
        assertLedger(candidate.state);
        adopt(candidate.state);
        const stateSaved = savePersisted(candidate.state);
        persistenceDirtyScope = stateSaved ? null : getActivePersistenceScope();
        if (!stateSaved) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'state_persistence_failed' });
          return 'retry';
        }
        if (!saveLedgerAuthorityReceipt(nextReceipt)) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'receipt_persistence_failed' });
          return 'retry';
        }
        if (freshTelegramPersistenceId === candidate.telegramId) {
          freshTelegramPersistenceId = null;
        }
        if (unconfirmedLocalSnapshotId === candidate.telegramId) {
          unconfirmedLocalSnapshotId = null;
        }
        if (approvedServerCopyId === candidate.telegramId) {
          approvedServerCopyId = null;
        }
        set({
          ledgerMode: 'server',
          ledgerSyncError: null,
          recoveredFromCorruption: false,
        });
        return decision === 'current' ? 'current' : 'applied';
      }, signal),
    );

  const executeServerCommand = async (
    command: BankCommand,
    clientMutationId = createClientMutationId(),
    signal?: AbortSignal,
  ): Promise<Extract<BankCommandOutcome, { readonly ok: true }>> => {
    const gateway = serverGateway;
    if (
      get().ledgerMode !== 'server' ||
      gateway === null ||
      getActiveTelegramPersistenceId() !== gateway.telegramId
    ) {
      throw new ServerLedgerReadOnlyError();
    }
    let response: Awaited<ReturnType<PlatformAdapter['executeBankCommand']>>;
    try {
      response = await gateway.execute(command, clientMutationId, signal);
    } catch (error: unknown) {
      handleServerRequestFailure(error);
      throw error;
    }
    const adoption = await adoptServerRevision(response, signal);
    if (adoption === 'retry' || adoption === 'retired') throw new ServerLedgerReadOnlyError();
    return response.outcome;
  };

  return {
    ...init.state,
    recoveredFromCorruption: init.recovered,
    ratesStatus: deriveRatesStatusAfterAdoption('idle', init.state.exchangeRates),
    ledgerMode: isTelegramPersistenceRuntime() ? 'read_only' : 'local',
    ledgerSyncError: null,

    async transfer(input) {
      if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
        try {
          const operationId = /^ct_[0-9a-f]{32}$/.test(input.clientTransferId)
            ? input.clientTransferId.slice(3)
            : createClientMutationId();
          const outcome = await executeServerCommand(
            { kind: 'transfer', request: input },
            operationId,
          );
          return {
            ok: true,
            state: pickBankState(get()),
            applied: outcome.applied,
            ...(outcome.incomingAmountMinor === undefined
              ? {}
              : { incomingAmountMinor: outcome.incomingAmountMinor }),
          };
        } catch (error: unknown) {
          if (
            error instanceof TelegramApiRequestError &&
            error.status === 422 &&
            TRANSFER_ERRORS.has(error.code)
          ) {
            return { ok: false, error: error.code as TransferError };
          }
          throw error;
        }
      }
      return withPersistenceLock(() => {
        const base = readMutationBase();
        const outcome = applyBankCommand(
          base,
          { kind: 'transfer', request: input },
          { nowISO: new Date().toISOString() },
        );
        if (!outcome.ok) {
          adopt(base);
          if (!TRANSFER_ERRORS.has(outcome.error)) {
            throw new Error(`Unexpected transfer error: ${outcome.error}`);
          }
          return { ok: false, error: outcome.error as TransferError };
        }
        commit(outcome.state);
        return {
          ok: true,
          state: outcome.state,
          applied: outcome.applied,
          ...(outcome.incomingAmountMinor === undefined
            ? {}
            : { incomingAmountMinor: outcome.incomingAmountMinor }),
        };
      });
    },

    async setPrimaryCurrency(primaryCurrency) {
      if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
        await executeServerCommand({ kind: 'set_primary_currency', currency: primaryCurrency });
        return;
      }
      await withPersistenceLock(() => {
        const current = readMutationBase();
        if (current.primaryCurrency === primaryCurrency) {
          adopt(current);
          return;
        }
        commit({ ...current, primaryCurrency });
      });
    },

    async isolateTelegramSession(telegramId, signal) {
      signal?.throwIfAborted();
      const previousScope = getActivePersistenceScope();
      const visible = pickBankState(get());
      const activeTelegramId = getActiveTelegramPersistenceId();
      if (
        isTelegramPersistenceRuntime() &&
        telegramId !== undefined &&
        activeTelegramId === telegramId &&
        visible.profile.telegramId === telegramId
      ) {
        if (serverGateway?.telegramId !== telegramId) {
          serverGateway = null;
          const requiresServerSync = hasStickyServerLedgerMode(telegramId);
          // This exact launch session already verified the local bridge. Keep
          // its mounted drafts during foreground refresh; a new fingerprint
          // still enters quarantine below, and sticky authority never falls back.
          if (get().ledgerMode !== 'local' || requiresServerSync) {
            set({
              ledgerMode: 'read_only',
              ledgerSyncError: requiresServerSync ? 'server_sync_required' : null,
            });
          }
        }
        return !isCurrentPersistenceDirty();
      }

      if (isTelegramPersistenceRuntime()) {
        serverGateway = null;
        freshTelegramPersistenceId = null;
        unconfirmedLocalSnapshotId = null;
        approvedServerCopyId = null;
        quarantineTelegramPersistence();
        persistenceDirtyScope = null;
        const seeded = buildSeed(new Date().toISOString());
        const isolated = {
          ...seeded,
          exchangeRates:
            visible.exchangeRates.source === 'frankfurter'
              ? visible.exchangeRates
              : seeded.exchangeRates,
        };
        assertLedger(isolated);
        adopt(isolated);
        set({
          ledgerMode: 'read_only',
          ledgerSyncError:
            telegramId !== undefined && hasStickyServerLedgerMode(telegramId)
              ? 'server_sync_required'
              : null,
        });
        reconcilePersistenceScopeChange(previousScope);
        return false;
      }

      return telegramId !== undefined && visible.profile.telegramId === telegramId;
    },

    async activateVerifiedTelegramSession(telegramId, signal) {
      signal?.throwIfAborted();
      const previousScope = getActivePersistenceScope();
      const visible = pickBankState(get());
      const sameVerifiedDirtySession =
        isTelegramPersistenceRuntime() &&
        getActiveTelegramPersistenceId() === telegramId &&
        visible.profile.telegramId === telegramId &&
        isCurrentPersistenceDirty();
      if (!activateTelegramPersistence(telegramId)) {
        freshTelegramPersistenceId = null;
        unconfirmedLocalSnapshotId = null;
        approvedServerCopyId = null;
        const seeded = buildSeed(new Date().toISOString());
        adopt({
          ...seeded,
          exchangeRates:
            visible.exchangeRates.source === 'frankfurter'
              ? visible.exchangeRates
              : seeded.exchangeRates,
        });
        persistenceDirtyScope = null;
        reconcilePersistenceScopeChange(previousScope);
        return false;
      }
      // Namespace activation is synchronous, while the following snapshot
      // restore can wait on a cross-tab lock or abort. Reset transient UI at
      // the authority boundary itself so no old-user draft survives that wait.
      reconcilePersistenceScopeChange(previousScope);

      // A failed write makes the in-memory state authoritative. Re-entering the
      // same verified namespace must not replace it with the older disk snapshot;
      // returning false forces preference sync to retry the durable commit.
      if (sameVerifiedDirtySession) {
        set({
          ledgerMode:
            serverGateway?.telegramId === telegramId
              ? 'server'
              : hasStickyServerLedgerMode(telegramId)
                ? 'read_only'
                : 'local',
        });
        return false;
      }

      if (
        visible.profile.telegramId !== undefined &&
        visible.profile.telegramId !== telegramId
      ) {
        const seeded = buildSeed(new Date().toISOString());
        adopt({
          ...seeded,
          exchangeRates:
            visible.exchangeRates.source === 'frankfurter'
              ? visible.exchangeRates
              : seeded.exchangeRates,
        });
      }
      persistenceDirtyScope = null;

      const aligned = await withPersistenceLock(() => {
        const persisted = loadPersisted();
        if (persisted.kind === 'ok') {
          freshTelegramPersistenceId = null;
          unconfirmedLocalSnapshotId =
            loadLedgerAuthorityReceipt(telegramId) === null
              ? telegramId
              : null;
          adopt(persisted.state);
          return true;
        }
        freshTelegramPersistenceId = telegramId;
        unconfirmedLocalSnapshotId = null;
        const current = pickBankState(get());
        const seeded = buildSeed(new Date().toISOString());
        adopt({
          ...seeded,
          exchangeRates:
            current.exchangeRates.source === 'frankfurter'
              ? current.exchangeRates
              : seeded.exchangeRates,
        });
        return false;
      }, signal);
      set({
        ledgerMode:
          serverGateway?.telegramId === telegramId
            ? 'server'
            : hasStickyServerLedgerMode(telegramId)
              ? 'read_only'
              : 'local',
        ledgerSyncError: null,
      });
      return aligned;
    },

    approveServerCopy() {
      const telegramId = getActiveTelegramPersistenceId();
      if (
        !isTelegramPersistenceRuntime() ||
        telegramId === undefined ||
        unconfirmedLocalSnapshotId !== telegramId ||
        get().ledgerSyncError !== 'server_copy_confirmation_required'
      ) {
        return false;
      }
      approvedServerCopyId = telegramId;
      return true;
    },

    async synchronizeTelegramBank(telegramId, bank, platform, signal) {
      signal.throwIfAborted();
      if (
        !isTelegramPersistenceRuntime() ||
        getActiveTelegramPersistenceId() !== telegramId
      ) {
        return 'retry';
      }

      if (bank === undefined) {
        serverGateway = null;
        if (hasStickyServerLedgerMode(telegramId)) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'server_api_unavailable' });
          return 'retry';
        }
        set({ ledgerMode: 'local', ledgerSyncError: null });
        return 'local';
      }

      let candidate: ServerBankRevision;
      if (bank.mode === 'import_required') {
        // This write precedes the network request. A committed import whose
        // response is lost can never fall back to a client-local ledger.
        if (!markStickyServerLedgerMode(telegramId)) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'receipt_persistence_failed' });
          return 'retry';
        }
        const local = pickBankState(get());
        if (local.profile.telegramId !== telegramId) {
          set({ ledgerMode: 'read_only', ledgerSyncError: 'telegram_session_changed' });
          return 'retry';
        }
        try {
          candidate = await platform.importBankState(
            {
              version: 1,
              importId: createClientMutationId(),
              stateVersion: SCHEMA_VERSION,
              state: local,
            },
            signal,
          );
        } catch (error: unknown) {
          handleServerRequestFailure(error);
          throw error;
        }
      } else {
        candidate = bank;
      }
      signal.throwIfAborted();
      const adoption = await adoptServerRevision(candidate, signal);
      if (adoption === 'retry' || adoption === 'retired') return 'retry';
      serverGateway = {
        telegramId,
        execute: (command, clientMutationId, commandSignal) =>
          platform.executeBankCommand(command, clientMutationId, commandSignal),
        refreshRates: (clientMutationId, refreshSignal) =>
          platform.refreshBankRates(clientMutationId, refreshSignal),
      };
      return adoption === 'stale' ? 'current' : adoption;
    },

    async applyLaunchPreferences(preferences, signal) {
      if (
        isTelegramPersistenceRuntime() &&
        getActiveTelegramPersistenceId() !== preferences.telegramId
      ) {
        return false;
      }
      return withPersistenceLock(() => {
        const current = readMutationBase();
        const freshVerifiedNamespace =
          isTelegramPersistenceRuntime() &&
          freshTelegramPersistenceId === preferences.telegramId;
        const switchedTelegramAccount =
          current.profile.telegramId !== undefined &&
          current.profile.telegramId !== preferences.telegramId;
        const seeded = freshVerifiedNamespace
          ? buildSeed(new Date().toISOString(), preferences.primaryCurrency)
          : switchedTelegramAccount
            ? buildSeed(new Date().toISOString())
          : null;
        const base = seeded === null
          ? current
          : {
              ...seeded,
              // Rates are public reference data, not user data. Preserve a live
              // snapshot so an account switch does not force an offline rate.
              exchangeRates:
                current.exchangeRates.source === 'frankfurter'
                  ? current.exchangeRates
                  : seeded.exchangeRates,
            };
        const profile = {
          displayName: preferences.displayName,
          telegramId: preferences.telegramId,
        };
        const unchanged =
          base.primaryCurrency === preferences.primaryCurrency &&
          base.profile.displayName === profile.displayName &&
          base.profile.telegramId === profile.telegramId;
        if (unchanged && !isCurrentPersistenceDirty()) {
          adopt(base);
          return true;
        }
        const saved = commit({
          ...base,
          primaryCurrency: preferences.primaryCurrency,
          profile,
        });
        if (saved && freshVerifiedNamespace) freshTelegramPersistenceId = null;
        return saved;
      }, signal);
    },

    async refreshRates(force = false) {
      if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
        const before = get().exchangeRates;
        if (!force && isFreshLiveSnapshot(before)) {
          set({ ratesStatus: 'fresh' });
          return 'cached';
        }
        const gateway = serverGateway;
        if (
          get().ledgerMode !== 'server' ||
          gateway === null ||
          getActiveTelegramPersistenceId() !== gateway.telegramId
        ) {
          const currentIsFresh = isFreshLiveSnapshot(get().exchangeRates);
          set({ ratesStatus: currentIsFresh ? 'fresh' : 'error' });
          return currentIsFresh ? 'cached' : 'failed';
        }

        set({ ratesStatus: 'loading' });
        try {
          const response = await gateway.refreshRates(createClientMutationId());
          const adoption = await adoptServerRevision(response);
          if (adoption === 'retry' || adoption === 'retired') {
            set({ ratesStatus: 'error' });
            return 'failed';
          }
          const current = get().exchangeRates;
          const currentIsFresh = isFreshLiveSnapshot(current);
          set({
            ratesStatus: currentIsFresh ? 'fresh' : 'error',
            ledgerSyncError: null,
          });
          if (!currentIsFresh) return 'failed';
          return hasRateSnapshotVersionChanged(before, current) ? 'updated' : 'cached';
        } catch (error: unknown) {
          handleServerRequestFailure(error);
          const current = get().exchangeRates;
          const currentIsFresh = isFreshLiveSnapshot(current);
          set({ ratesStatus: currentIsFresh ? 'fresh' : 'error' });
          return currentIsFresh && hasRateSnapshotVersionChanged(before, current)
            ? 'cached'
            : 'failed';
        }
      }
      const before = get();
      if (!force && isFreshLiveSnapshot(before.exchangeRates)) {
        set({ ratesStatus: 'fresh' });
        return 'cached';
      }

      set({ ratesStatus: 'loading' });
      const request = getOrStartRatesRequest();
      try {
        const exchangeRates = await request.promise;
        const updated = await withPersistenceLock(() => {
          const current = readMutationBase();
          if (isNewerLiveSnapshot(current.exchangeRates, exchangeRates)) {
            adopt(current);
            return false;
          }
          commit({ ...current, exchangeRates });
          return true;
        });
        const selectedIsFresh = isFreshLiveSnapshot(get().exchangeRates);
        if (request.generation === latestRatesRequestGeneration) {
          set({ ratesStatus: selectedIsFresh ? 'fresh' : 'error' });
        }
        return updated ? 'updated' : selectedIsFresh ? 'cached' : 'failed';
      } catch {
        const current = get().exchangeRates;
        const currentIsFresh = isFreshLiveSnapshot(current);
        if (request.generation === latestRatesRequestGeneration) {
          set({ ratesStatus: currentIsFresh ? 'fresh' : 'error' });
        }
        return currentIsFresh && hasRateSnapshotVersionChanged(before.exchangeRates, current)
          ? 'cached'
          : 'failed';
      }
    },

    async settleNow() {
      try {
        if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
          if (get().ledgerMode === 'server') {
            const nowISO = new Date().toISOString();
            if (!needsServerMaterialization(pickBankState(get()), nowISO)) return;
            const telegramId = getActiveTelegramPersistenceId();
            if (telegramId !== undefined) {
              const existing = serverSettlementRequest;
              if (existing !== null && existing.telegramId === telegramId) {
                await existing.promise;
                return;
              }
              const request: ServerSettlementRequest = {
                telegramId,
                promise: executeServerCommand({ kind: 'settle' }).then(() => undefined),
              };
              serverSettlementRequest = request;
              try {
                await request.promise;
              } finally {
                if (serverSettlementRequest === request) serverSettlementRequest = null;
              }
              return;
            }
          }
          // Preserve the read-only fail-closed path and impossible server-mode
          // namespace failures: the action must never fall back to local writes.
          await executeServerCommand({ kind: 'settle' });
          return;
        }
        await withPersistenceLock(() => {
          const before = readMutationBase();
          const settlement = applySettleAllWithinTransactionLimit(
            before,
            new Date().toISOString(),
          );
          if (!settlement.applied) {
            adopt(before);
            return;
          }
          commit(settlement.state);
        });
      } catch (error: unknown) {
        console.error('[cometa] interest settlement failed', error);
      }
    },

    async toggleCardFreeze(cardId) {
      if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
        const card = get().cards.find((candidate) => candidate.id === cardId);
        if (card === undefined) return;
        await executeServerCommand({
          kind: 'set_card_frozen',
          cardId,
          frozen: card.status === 'active',
        });
        return;
      }
      await withPersistenceLock(() => {
        const current = readMutationBase();
        const card = current.cards.find((candidate) => candidate.id === cardId);
        if (card === undefined) {
          adopt(current);
          return;
        }
        const outcome = applyBankCommand(current, {
          kind: 'set_card_frozen',
          cardId,
          frozen: card.status === 'active',
        }, {
          nowISO: new Date().toISOString(),
        });
        if (!outcome.ok || !outcome.applied) {
          adopt(current);
          return;
        }
        commit(outcome.state);
      });
    },

    async resetDemo() {
      if (isTelegramPersistenceRuntime() && get().ledgerMode !== 'local') {
        await executeServerCommand({ kind: 'reset_demo' });
        set({ recoveredFromCorruption: false });
        return;
      }
      await withPersistenceLock(() => {
        const current = readMutationBase();
        const reset = rebuildDemoBase(
          current,
          current.demoBaseCurrency,
          new Date().toISOString(),
        );
        commit({
          ...reset,
          primaryCurrency: current.primaryCurrency,
        });
      });
      set({ recoveredFromCorruption: false });
    },
  };
});

// First-run persistence + cross-tab subscription (module scope: one per tab).
if (typeof window !== 'undefined') {
  onCrossTabChange((state) => {
    if (useBankStore.getState().ledgerMode === 'local' && !isCurrentPersistenceDirty()) {
      const previous = pickBankState(useBankStore.getState());
      const localRatesStatus = useBankStore.getState().ratesStatus;
      useBankStore.setState({
        ...state,
        ratesStatus: deriveRatesStatusAfterAdoption(localRatesStatus, state.exchangeRates),
      });
      reconcileUiAfterBankStateChange(previous, state);
    }
  });
  void withPersistenceLock(() => {
    if (isCurrentPersistenceDirty()) return;
    const persisted = loadPersisted();
    if (persisted.kind === 'ok') {
      const previous = pickBankState(useBankStore.getState());
      const localRatesStatus = useBankStore.getState().ratesStatus;
      useBankStore.setState({
        ...persisted.state,
        ratesStatus: deriveRatesStatusAfterAdoption(
          localRatesStatus,
          persisted.state.exchangeRates,
        ),
      });
      reconcileUiAfterBankStateChange(previous, persisted.state);
      return;
    }
    const saved = savePersisted(pickBankState(useBankStore.getState()));
    persistenceDirtyScope = saved ? null : getActivePersistenceScope();
  }).catch(handleInitialPersistenceFailure);
}
