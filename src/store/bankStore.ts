import { create } from 'zustand';
import type { BankState, Currency, ExchangeRateSnapshot } from '@/domain/types';
import type { LaunchPreferences } from '@/platform/types';
import { applyTransfer, type TransferOutcome, type TransferRequest } from '@/domain/transfer';
import { applySettleAll } from '@/domain/interest';
import { buildSeed } from '@/domain/seed';
import { assertLedger } from '@/domain/invariants';
import { fetchExchangeRates, isRateSnapshotDateCoherent } from '@/services/exchangeRates';
import {
  activateTelegramPersistence,
  getActivePersistenceScope,
  getActiveTelegramPersistenceId,
  isTelegramPersistenceRuntime,
  loadPersisted,
  savePersisted,
  onCrossTabChange,
  quarantineTelegramPersistence,
  withPersistenceLock,
} from './persistence';

export type RatesStatus = 'idle' | 'loading' | 'fresh' | 'error';
export type RatesRefreshResult = 'updated' | 'cached' | 'failed';

const LIVE_RATE_CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface RatesRequest {
  readonly generation: number;
  readonly promise: Promise<ExchangeRateSnapshot>;
}

let ratesRequest: RatesRequest | null = null;
let latestRatesRequestGeneration = 0;
let persistenceDirtyScope: string | null = null;

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

  transfer(input: TransferRequest): Promise<TransferOutcome>;
  setPrimaryCurrency(currency: Currency): Promise<void>;
  applyLaunchPreferences(
    preferences: LaunchPreferences,
    signal?: AbortSignal,
  ): Promise<boolean>;
  isolateTelegramSession(telegramId: string | undefined, signal?: AbortSignal): Promise<boolean>;
  activateVerifiedTelegramSession(telegramId: string, signal?: AbortSignal): Promise<boolean>;
  refreshRates(force?: boolean): Promise<RatesRefreshResult>;
  settleNow(): Promise<void>;
  toggleCardFreeze(cardId: string): Promise<void>;
  resetDemo(): Promise<void>;
}

function pickBankState(state: BankState): BankState {
  return {
    primaryCurrency: state.primaryCurrency,
    exchangeRates: state.exchangeRates,
    accounts: state.accounts,
    transactions: state.transactions,
    cards: state.cards,
    contacts: state.contacts,
    profile: state.profile,
    nextSeq: state.nextSeq,
    recentTransferIds: state.recentTransferIds,
  };
}

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

export const useBankStore = create<BankStore>()((set, get) => {
  const adopt = (next: BankState) => {
    set({
      ...next,
      ratesStatus: deriveRatesStatusAfterAdoption(get().ratesStatus, next.exchangeRates),
    });
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

  return {
    ...init.state,
    recoveredFromCorruption: init.recovered,
    ratesStatus: deriveRatesStatusAfterAdoption('idle', init.state.exchangeRates),

    async transfer(input) {
      return withPersistenceLock(() => {
        const base = readMutationBase();
        const outcome = applyTransfer(base, {
          ...input,
          nowISO: new Date().toISOString(),
        });
        if (outcome.ok) commit(outcome.state);
        else adopt(base);
        return outcome;
      });
    },

    async setPrimaryCurrency(primaryCurrency) {
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
      const visible = pickBankState(get());
      const activeTelegramId = getActiveTelegramPersistenceId();
      if (
        isTelegramPersistenceRuntime() &&
        telegramId !== undefined &&
        activeTelegramId === telegramId &&
        visible.profile.telegramId === telegramId
      ) {
        return !isCurrentPersistenceDirty();
      }

      if (isTelegramPersistenceRuntime()) {
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
        return false;
      }

      return telegramId !== undefined && visible.profile.telegramId === telegramId;
    },

    async activateVerifiedTelegramSession(telegramId, signal) {
      signal?.throwIfAborted();
      const visible = pickBankState(get());
      const sameVerifiedDirtySession =
        isTelegramPersistenceRuntime() &&
        getActiveTelegramPersistenceId() === telegramId &&
        visible.profile.telegramId === telegramId &&
        isCurrentPersistenceDirty();
      if (!activateTelegramPersistence(telegramId)) {
        const seeded = buildSeed(new Date().toISOString());
        adopt({
          ...seeded,
          exchangeRates:
            visible.exchangeRates.source === 'frankfurter'
              ? visible.exchangeRates
              : seeded.exchangeRates,
        });
        persistenceDirtyScope = null;
        return false;
      }

      // A failed write makes the in-memory state authoritative. Re-entering the
      // same verified namespace must not replace it with the older disk snapshot;
      // returning false forces preference sync to retry the durable commit.
      if (sameVerifiedDirtySession) return false;

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

      return withPersistenceLock(() => {
        const persisted = loadPersisted();
        if (persisted.kind === 'ok') {
          adopt(persisted.state);
          return true;
        }
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
        const switchedTelegramAccount =
          current.profile.telegramId !== undefined &&
          current.profile.telegramId !== preferences.telegramId;
        const seeded = switchedTelegramAccount
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
        return commit({
          ...base,
          primaryCurrency: preferences.primaryCurrency,
          profile,
        });
      }, signal);
    },

    async refreshRates(force = false) {
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
        await withPersistenceLock(() => {
          const before = readMutationBase();
          const after = applySettleAll(before, new Date().toISOString());
          if (after === before) {
            adopt(before);
            return;
          }
          commit(after);
        });
      } catch (error: unknown) {
        console.error('[cometa] interest settlement failed', error);
      }
    },

    async toggleCardFreeze(cardId) {
      await withPersistenceLock(() => {
        const current = readMutationBase();
        commit({
          ...current,
          cards: current.cards.map((card) =>
            card.id === cardId
              ? { ...card, status: card.status === 'active' ? 'frozen' : 'active' }
              : card,
          ),
        });
      });
    },

    async resetDemo() {
      await withPersistenceLock(() => {
        const current = readMutationBase();
        const seeded = buildSeed(new Date().toISOString());
        commit({
          ...seeded,
          primaryCurrency: current.primaryCurrency,
          exchangeRates:
            current.exchangeRates.source === 'frankfurter'
              ? current.exchangeRates
              : seeded.exchangeRates,
          profile: current.profile,
        });
      });
      set({ recoveredFromCorruption: false });
    },
  };
});

// First-run persistence + cross-tab subscription (module scope: one per tab).
if (typeof window !== 'undefined') {
  onCrossTabChange((state) => {
    if (!isCurrentPersistenceDirty()) {
      const localRatesStatus = useBankStore.getState().ratesStatus;
      useBankStore.setState({
        ...state,
        ratesStatus: deriveRatesStatusAfterAdoption(localRatesStatus, state.exchangeRates),
      });
    }
  });
  void withPersistenceLock(() => {
    if (isCurrentPersistenceDirty()) return;
    const persisted = loadPersisted();
    if (persisted.kind === 'ok') {
      const localRatesStatus = useBankStore.getState().ratesStatus;
      useBankStore.setState({
        ...persisted.state,
        ratesStatus: deriveRatesStatusAfterAdoption(
          localRatesStatus,
          persisted.state.exchangeRates,
        ),
      });
      return;
    }
    const saved = savePersisted(pickBankState(useBankStore.getState()));
    persistenceDirtyScope = saved ? null : getActivePersistenceScope();
  }).catch(handleInitialPersistenceFailure);
}
