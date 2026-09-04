import type { LaunchPreferences, PlatformAdapter } from '@/platform/types';
import { useBankStore } from '@/store/bankStore';
import {
  loadAppliedLaunchPreferencesReceipt,
  saveAppliedLaunchPreferencesReceipt,
  SCHEMA_VERSION,
  withLaunchPreferencesLock,
  type AppliedLaunchPreferencesReceipt,
} from '@/store/persistence';
import { useUiStore } from '@/store/uiStore';

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
  saveAppliedReceipt(receipt: AppliedLaunchPreferencesReceipt): boolean;
}

const defaultTarget: LaunchPreferenceTarget = {
  isolateBankSession: async (telegramId, signal) => {
    const aligned = await useBankStore.getState().isolateTelegramSession(telegramId, signal);
    if (!aligned) {
      useUiStore.getState().reloadLocalePreference();
      useUiStore.getState().resetUi();
    }
    return aligned;
  },
  activateVerifiedSession: async (telegramId, signal) => {
    const aligned = await useBankStore
      .getState()
      .activateVerifiedTelegramSession(telegramId, signal);
    useUiStore.getState().reloadLocalePreference();
    useUiStore.getState().resetUi();
    return aligned;
  },
  getAppliedReceipt: loadAppliedLaunchPreferencesReceipt,
  setLocale: (preferences) => useUiStore.getState().setLocale(preferences.locale),
  applyBankPreferences: (preferences, signal) =>
    useBankStore.getState().applyLaunchPreferences(preferences, signal),
  saveAppliedReceipt: saveAppliedLaunchPreferencesReceipt,
};

export type LaunchPreferenceSyncResult = 'absent' | 'current' | 'applied' | 'retry';

export async function synchronizeLaunchPreferences(
  platform: PlatformAdapter,
  signal: AbortSignal,
  target: LaunchPreferenceTarget = defaultTarget,
  onIdentityIsolated?: VoidFunction,
): Promise<LaunchPreferenceSyncResult> {
  const hostTelegramId = platform.getCurrentUser().telegramId;
  await target.isolateBankSession(hostTelegramId, signal);
  signal.throwIfAborted();
  onIdentityIsolated?.();
  const preferences = await platform.loadLaunchPreferences(signal);
  if (preferences === null) return 'absent';
  signal.throwIfAborted();

  return withLaunchPreferencesLock(signal, async () => {
    signal.throwIfAborted();
    const verifiedSessionAligned = await target.activateVerifiedSession(
      preferences.telegramId,
      signal,
    );
    signal.throwIfAborted();
    const applied = target.getAppliedReceipt();
    if (
      verifiedSessionAligned &&
      applied?.telegramId === preferences.telegramId &&
      applied.revisionEpoch === preferences.revisionEpoch &&
      applied.revision >= preferences.revision
    ) {
      return 'current';
    }

    // Locale and BankState must both reach durable storage before the receipt
    // advances. A partial write is retried on the next launch.
    const localeSaved = target.setLocale(preferences);
    signal.throwIfAborted();
    const bankSaved = await target.applyBankPreferences(preferences, signal);
    signal.throwIfAborted();
    if (!localeSaved || !bankSaved) return 'retry';
    return target.saveAppliedReceipt({
      version: 2,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: preferences.telegramId,
      revisionEpoch: preferences.revisionEpoch,
      revision: preferences.revision,
    })
      ? 'applied'
      : 'retry';
  });
}
