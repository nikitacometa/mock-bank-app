import type {
  LaunchBankState,
  LaunchPreferences,
  PlatformAdapter,
} from '@/platform/types';
import { markLedgerClientContract } from '@/platform/ledgerClientContract';
import { useBankStore } from '@/store/bankStore';
import {
  loadAppliedLaunchPreferencesReceipt,
  saveAppliedLaunchPreferencesReceipt,
  SCHEMA_VERSION,
  withLaunchPreferencesLock,
  type AppliedLaunchPreferencesReceipt,
} from '@/store/persistence';
import { useUiStore } from '@/store/uiStore';

const verifiedSessionFingerprints = new WeakMap<PlatformAdapter, string>();
const isolatedSessionBoundaries = new WeakMap<
  PlatformAdapter,
  { readonly epoch: number; readonly fingerprint: string | undefined }
>();
let nextLaunchSynchronizationEpoch = 0;

export interface LaunchPreferenceTarget {
  /** True only when the visible BankState was already bound to this exact host identity. */
  isolateBankSession(telegramId: string | undefined, signal: AbortSignal): Promise<boolean>;
  /** Enter an HMAC-verified per-user persistence namespace and restore its exact snapshot. */
  activateVerifiedSession(telegramId: string, signal: AbortSignal): Promise<boolean>;
  getAppliedReceipt(): AppliedLaunchPreferencesReceipt | null;
  setLocale(preferences: LaunchPreferences): boolean;
  applyBankPreferences(
    preferences: LaunchPreferences,
    signal: AbortSignal,
  ): Promise<boolean>;
  synchronizeBank(
    telegramId: string,
    bank: LaunchBankState | undefined,
    platform: PlatformAdapter,
    signal: AbortSignal,
  ): Promise<'local' | 'current' | 'applied' | 'retry'>;
  saveAppliedReceipt(receipt: AppliedLaunchPreferencesReceipt): boolean;
  markClientContract(telegramId: string): boolean;
}

const defaultTarget: LaunchPreferenceTarget = {
  isolateBankSession: (telegramId, signal) =>
    useBankStore.getState().isolateTelegramSession(telegramId, signal),
  activateVerifiedSession: (telegramId, signal) =>
    useBankStore.getState().activateVerifiedTelegramSession(telegramId, signal),
  getAppliedReceipt: loadAppliedLaunchPreferencesReceipt,
  setLocale: (preferences) => useUiStore.getState().setLocale(preferences.locale),
  applyBankPreferences: (preferences, signal) =>
    useBankStore.getState().applyLaunchPreferences(preferences, signal),
  synchronizeBank: (telegramId, bank, platform, signal) =>
    useBankStore.getState().synchronizeTelegramBank(telegramId, bank, platform, signal),
  saveAppliedReceipt: saveAppliedLaunchPreferencesReceipt,
  markClientContract: markLedgerClientContract,
};

export type LaunchPreferenceSyncResult = 'absent' | 'current' | 'applied' | 'retry';

export async function synchronizeLaunchPreferences(
  platform: PlatformAdapter,
  signal: AbortSignal,
  target: LaunchPreferenceTarget = defaultTarget,
  onIdentityIsolated?: VoidFunction,
): Promise<LaunchPreferenceSyncResult> {
  const synchronizationEpoch = ++nextLaunchSynchronizationEpoch;
  const observesSessionFingerprint = platform.getSessionFingerprint !== undefined;
  const sessionFingerprint = platform.getSessionFingerprint?.();
  const sessionFingerprintChanged = (): boolean =>
    observesSessionFingerprint &&
    platform.getSessionFingerprint?.() !== sessionFingerprint;
  const recordIsolatedBoundary = (fingerprint: string | undefined): void => {
    const current = isolatedSessionBoundaries.get(platform);
    if (current === undefined || current.epoch < synchronizationEpoch) {
      isolatedSessionBoundaries.set(platform, {
        epoch: synchronizationEpoch,
        fingerprint,
      });
    }
  };
  const quarantineObservedSession = async (): Promise<boolean> => {
    const observedFingerprint = platform.getSessionFingerprint?.();
    const newerBoundary = isolatedSessionBoundaries.get(platform);
    if (
      (observedFingerprint !== undefined &&
        verifiedSessionFingerprints.get(platform) === observedFingerprint) ||
      (newerBoundary !== undefined &&
        newerBoundary.epoch > synchronizationEpoch &&
        newerBoundary.fingerprint === observedFingerprint)
    ) {
      return false;
    }
    if (verifiedSessionFingerprints.get(platform) === sessionFingerprint) {
      verifiedSessionFingerprints.delete(platform);
    }
    // A detected identity boundary must not be cancelled by the obsolete
    // foreground request that happened to discover it.
    await target.isolateBankSession(undefined, new AbortController().signal);
    recordIsolatedBoundary(observedFingerprint);
    return true;
  };
  const fingerprintAlreadyVerified =
    !observesSessionFingerprint ||
    (sessionFingerprint !== undefined &&
      verifiedSessionFingerprints.get(platform) === sessionFingerprint);
  // Parsed InitData can trail the raw Telegram session. Until this exact raw
  // session completes a server bootstrap, no parsed ID may retain or reopen a
  // persistence namespace from the previous session.
  let hostTelegramId: string | undefined;
  if (fingerprintAlreadyVerified) {
    const parsedTelegramId = platform.getCurrentUser().telegramId;
    if (!sessionFingerprintChanged()) hostTelegramId = parsedTelegramId;
  }
  await target.isolateBankSession(hostTelegramId, signal);
  if (observesSessionFingerprint && !sessionFingerprintChanged()) {
    recordIsolatedBoundary(sessionFingerprint);
  }
  signal.throwIfAborted();
  onIdentityIsolated?.();
  let launch: Awaited<ReturnType<PlatformAdapter['loadLaunchState']>>;
  try {
    launch = await platform.loadLaunchState(signal);
  } catch (error: unknown) {
    if (sessionFingerprintChanged()) await quarantineObservedSession();
    throw error;
  }
  if (sessionFingerprintChanged()) {
    await quarantineObservedSession();
    return 'retry';
  }
  if (launch === null) return 'absent';
  signal.throwIfAborted();

  try {
    return await withLaunchPreferencesLock(signal, async () => {
      if (
        observesSessionFingerprint &&
        (sessionFingerprint === undefined || sessionFingerprintChanged())
      ) {
        await quarantineObservedSession();
        return 'retry';
      }
      signal.throwIfAborted();
      const verifiedSessionAligned = await target.activateVerifiedSession(
        launch.telegramId,
        signal,
      );
      if (
        observesSessionFingerprint &&
        (sessionFingerprint === undefined || sessionFingerprintChanged())
      ) {
        await quarantineObservedSession();
        return 'retry';
      }
      signal.throwIfAborted();
      if (sessionFingerprint !== undefined) {
        verifiedSessionFingerprints.set(platform, sessionFingerprint);
      }
      const applied = target.getAppliedReceipt();
      const preferencesCurrent =
        verifiedSessionAligned &&
        applied?.telegramId === launch.telegramId &&
        applied.revisionEpoch === launch.revisionEpoch &&
        applied.revision >= launch.revision;

      // Locale and BankState must both reach durable storage before the receipt
      // advances. A partial write is retried on the next launch.
      if (!preferencesCurrent) {
        const localeSaved = target.setLocale(launch);
        signal.throwIfAborted();
        // A canonical server snapshot owns these fields. Local preference
        // projection is needed only for bridge-local state and first import.
        const bankSaved = launch.bank?.mode === 'server'
          ? true
          : await target.applyBankPreferences(launch, signal);
        signal.throwIfAborted();
        if (!localeSaved || !bankSaved) return 'retry';
      }

      const bankResult = await target.synchronizeBank(
        launch.telegramId,
        launch.bank,
        platform,
        signal,
      );
      signal.throwIfAborted();
      if (bankResult === 'retry') return 'retry';

      if (!preferencesCurrent) {
        const saved = target.saveAppliedReceipt({
          version: 2,
          bankSchemaVersion: SCHEMA_VERSION,
          telegramId: launch.telegramId,
          revisionEpoch: launch.revisionEpoch,
          revision: launch.revision,
        });
        if (!saved) return 'retry';
      }
      if (!target.markClientContract(launch.telegramId)) return 'retry';
      return preferencesCurrent && (bankResult === 'current' || bankResult === 'local')
        ? 'current'
        : 'applied';
    });
  } catch (error: unknown) {
    if (sessionFingerprintChanged()) await quarantineObservedSession();
    throw error;
  }
}
