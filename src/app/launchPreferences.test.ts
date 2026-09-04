import { describe, expect, it, vi } from 'vitest';
import type { LaunchPreferences, PlatformAdapter } from '@/platform/types';
import { SCHEMA_VERSION, type AppliedLaunchPreferencesReceipt } from '@/store/persistence';
import {
  synchronizeLaunchPreferences,
  type LaunchPreferenceTarget,
} from './launchPreferences';

const PREFERENCES: LaunchPreferences = {
  version: 1,
  revisionEpoch: '0123456789abcdef0123456789abcdef',
  revision: 4,
  locale: 'en',
  primaryCurrency: 'GEL',
  displayName: 'Ada Lovelace',
  telegramId: '9007199254740993',
};

function platform(value: LaunchPreferences | null): PlatformAdapter {
  return {
    isTelegram: true,
    getCurrentUser: () => ({
      displayName: 'Ada',
      source: 'host',
      ...(value === null ? {} : { telegramId: value.telegramId }),
    }),
    loadLaunchPreferences: vi.fn(async () => value),
    haptic() {},
    copyText: async () => false,
    mainButton: { supported: false, show() {}, hide() {} },
    armBack: () => () => undefined,
  };
}

function target(
  appliedRevision = 0,
  persistence: { locale?: boolean; bank?: boolean; revision?: boolean } = {},
): LaunchPreferenceTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isolateBankSession: async () => true,
    activateVerifiedSession: async () => true,
    getAppliedReceipt: () => appliedRevision === 0
      ? null
        : {
          version: 2,
          bankSchemaVersion: SCHEMA_VERSION,
          telegramId: PREFERENCES.telegramId,
          revisionEpoch: PREFERENCES.revisionEpoch,
          revision: appliedRevision,
        },
    setLocale: (preferences) => {
      calls.push(`locale:${preferences.locale}`);
      return persistence.locale ?? true;
    },
    applyBankPreferences: async (preferences, signal) => {
      signal.throwIfAborted();
      calls.push(`bank:${preferences.primaryCurrency}:${preferences.telegramId}`);
      return persistence.bank ?? true;
    },
    saveAppliedReceipt: (receipt) => {
      calls.push(`receipt:${receipt.telegramId}:${receipt.revision}`);
      return persistence.revision ?? true;
    },
  };
}

describe('synchronizeLaunchPreferences', () => {
  it('applies a newer server revision in locale, bank, marker order', async () => {
    const destination = target(3);

    await expect(
      synchronizeLaunchPreferences(platform(PREFERENCES), new AbortController().signal, destination),
    ).resolves.toBe('applied');

    expect(destination.calls).toEqual([
      'locale:en',
      'bank:GEL:9007199254740993',
      'receipt:9007199254740993:4',
    ]);
  });

  it('restores the same verified namespace without overwriting unchanged in-app choices', async () => {
    const destination = target(4);
    destination.isolateBankSession = async () => false;
    destination.activateVerifiedSession = async (telegramId) => {
      expect(telegramId).toBe(PREFERENCES.telegramId);
      return true;
    };
    const source = platform(PREFERENCES);
    source.getCurrentUser = () => ({ displayName: 'Никита', source: 'demo' });

    await expect(
      synchronizeLaunchPreferences(source, new AbortController().signal, destination),
    ).resolves.toBe('current');

    expect(destination.calls).toEqual([]);
  });

  it('leaves the marker retryable when locale or BankState persistence fails', async () => {
    const destination = target(0, { bank: false });

    await expect(
      synchronizeLaunchPreferences(platform(PREFERENCES), new AbortController().signal, destination),
    ).resolves.toBe('retry');

    expect(destination.calls).toEqual(['locale:en', 'bank:GEL:9007199254740993']);
  });

  it('applies a lower revision when it belongs to a different Telegram account', async () => {
    const destination = target(9);
    destination.getAppliedReceipt = () => ({
      version: 2,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: '43',
      revisionEpoch: PREFERENCES.revisionEpoch,
      revision: 9,
    });

    await expect(
      synchronizeLaunchPreferences(platform(PREFERENCES), new AbortController().signal, destination),
    ).resolves.toBe('applied');

    expect(destination.calls).toEqual([
      'locale:en',
      'bank:GEL:9007199254740993',
      'receipt:9007199254740993:4',
    ]);
  });

  it('applies a lower revision from a different server database epoch', async () => {
    const destination = target(9);
    destination.getAppliedReceipt = () => ({
      version: 2,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: PREFERENCES.telegramId,
      revisionEpoch: 'fedcba9876543210fedcba9876543210',
      revision: 9,
    });

    await expect(
      synchronizeLaunchPreferences(platform(PREFERENCES), new AbortController().signal, destination),
    ).resolves.toBe('applied');

    expect(destination.calls).toEqual([
      'locale:en',
      'bank:GEL:9007199254740993',
      'receipt:9007199254740993:4',
    ]);
  });

  it('serializes concurrent responses so an older revision cannot overwrite a newer one', async () => {
    let applied: AppliedLaunchPreferencesReceipt | null = null;
    let releaseFirst: VoidFunction = () => undefined;
    const firstBankWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const destination: LaunchPreferenceTarget = {
      isolateBankSession: async () => true,
      activateVerifiedSession: async () => true,
      getAppliedReceipt: () => applied,
      setLocale: (preferences) => {
        calls.push(`locale:${preferences.revision}`);
        return true;
      },
      applyBankPreferences: async (preferences, signal) => {
        calls.push(`bank:${preferences.revision}`);
        if (preferences.revision === 5) await firstBankWrite;
        signal.throwIfAborted();
        return true;
      },
      saveAppliedReceipt: (receipt) => {
        applied = receipt;
        calls.push(`receipt:${receipt.revision}`);
        return true;
      },
    };
    const newer = { ...PREFERENCES, revision: 5 };
    const older = { ...PREFERENCES, revision: 4 };

    const newerSync = synchronizeLaunchPreferences(
      platform(newer),
      new AbortController().signal,
      destination,
    );
    await vi.waitFor(() => expect(calls).toContain('bank:5'));
    const olderSync = synchronizeLaunchPreferences(
      platform(older),
      new AbortController().signal,
      destination,
    );
    releaseFirst();

    await expect(Promise.all([newerSync, olderSync])).resolves.toEqual(['applied', 'current']);
    expect(calls).toEqual(['locale:5', 'bank:5', 'receipt:5']);
    expect(applied).toEqual({
      version: 2,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: PREFERENCES.telegramId,
      revisionEpoch: PREFERENCES.revisionEpoch,
      revision: 5,
    });
  });

  it('reaches the identity isolation boundary before starting the bootstrap request', async () => {
    const calls: string[] = [];
    const destination = target();
    destination.isolateBankSession = async () => {
      calls.push('isolated');
      return false;
    };
    const source = platform(PREFERENCES);
    source.getCurrentUser = () => ({ displayName: 'Ada', source: 'demo' });
    source.loadLaunchPreferences = vi.fn(async () => {
      calls.push('fetch');
      return PREFERENCES;
    });
    const onIdentityIsolated = vi.fn(() => calls.push('boundary'));

    await expect(
      synchronizeLaunchPreferences(
        source,
        new AbortController().signal,
        destination,
        onIdentityIsolated,
      ),
    ).resolves.toBe('applied');

    expect(calls).toEqual(['isolated', 'boundary', 'fetch']);
    expect(onIdentityIsolated).toHaveBeenCalledOnce();
  });

  it('does not signal a safe boundary when identity isolation aborts', async () => {
    const controller = new AbortController();
    const destination = target();
    destination.isolateBankSession = vi.fn(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
      return false;
    });
    const source = platform(PREFERENCES);
    const onIdentityIsolated = vi.fn();

    await expect(
      synchronizeLaunchPreferences(
        source,
        controller.signal,
        destination,
        onIdentityIsolated,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(onIdentityIsolated).not.toHaveBeenCalled();
    expect(source.loadLaunchPreferences).not.toHaveBeenCalled();
  });

  it('quarantines an unavailable identity before a retryable network failure', async () => {
    const calls: string[] = [];
    const destination = target();
    destination.isolateBankSession = async (telegramId) => {
      calls.push(`isolate:${String(telegramId)}`);
      return false;
    };
    const source = platform(PREFERENCES);
    source.getCurrentUser = () => ({ displayName: 'Ada', source: 'demo' });
    source.loadLaunchPreferences = vi.fn(async () => {
      calls.push('fetch');
      throw Object.assign(new TypeError('offline'), { retryable: true });
    });
    const onIdentityIsolated = vi.fn(() => calls.push('boundary'));

    await expect(
      synchronizeLaunchPreferences(
        source,
        new AbortController().signal,
        destination,
        onIdentityIsolated,
      ),
    ).rejects.toMatchObject({ retryable: true });

    expect(calls).toEqual(['isolate:undefined', 'boundary', 'fetch']);
    expect(destination.calls).toEqual([]);
  });

  it('bypasses a stale matching receipt when the verified namespace has no matching state', async () => {
    const destination = target(PREFERENCES.revision);
    destination.isolateBankSession = async (telegramId) => {
      expect(telegramId).toBeUndefined();
      return false;
    };
    destination.activateVerifiedSession = async () => false;

    const source = platform(PREFERENCES);
    source.getCurrentUser = () => ({ displayName: 'Ada', source: 'demo' });

    await expect(
      synchronizeLaunchPreferences(source, new AbortController().signal, destination),
    ).resolves.toBe('applied');

    expect(destination.calls).toEqual([
      'locale:en',
      'bank:GEL:9007199254740993',
      'receipt:9007199254740993:4',
    ]);
  });

  it('recovers a different Telegram session after identity loss and a failed network attempt', async () => {
    const host = { telegramId: undefined as string | undefined };
    let visibleTelegramId: string | undefined = '41';
    let attempts = 0;
    const calls: string[] = [];
    const source = platform(PREFERENCES);
    source.getCurrentUser = () => ({
      displayName: host.telegramId === undefined ? 'Никита' : 'Ada',
      source: host.telegramId === undefined ? 'demo' : 'host',
      ...(host.telegramId === undefined ? {} : { telegramId: host.telegramId }),
    });
    source.loadLaunchPreferences = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new TypeError('offline'), { retryable: true });
      }
      return PREFERENCES;
    });
    const destination: LaunchPreferenceTarget = {
      isolateBankSession: async (telegramId) => {
        const aligned = telegramId !== undefined && visibleTelegramId === telegramId;
        if (!aligned && visibleTelegramId !== undefined) {
          calls.push(`quarantine:${visibleTelegramId}`);
          visibleTelegramId = undefined;
        }
        return aligned;
      },
      activateVerifiedSession: async (telegramId) => {
        const aligned = visibleTelegramId === telegramId;
        if (!aligned) visibleTelegramId = undefined;
        return aligned;
      },
      getAppliedReceipt: () => ({
        version: 2,
        bankSchemaVersion: SCHEMA_VERSION,
        telegramId: PREFERENCES.telegramId,
        revisionEpoch: PREFERENCES.revisionEpoch,
        revision: PREFERENCES.revision,
      }),
      setLocale: () => true,
      applyBankPreferences: async (preferences) => {
        visibleTelegramId = preferences.telegramId;
        calls.push(`apply:${preferences.telegramId}`);
        return true;
      },
      saveAppliedReceipt: () => true,
    };

    await expect(
      synchronizeLaunchPreferences(source, new AbortController().signal, destination),
    ).rejects.toMatchObject({ retryable: true });
    expect(visibleTelegramId).toBeUndefined();

    host.telegramId = PREFERENCES.telegramId;
    await expect(
      synchronizeLaunchPreferences(source, new AbortController().signal, destination),
    ).resolves.toBe('applied');

    expect(visibleTelegramId).toBe(PREFERENCES.telegramId);
    expect(calls).toEqual(['quarantine:41', `apply:${PREFERENCES.telegramId}`]);
  });

  it('does not write preferences after cancellation', async () => {
    const controller = new AbortController();
    const destination = target();
    const delayedPlatform = platform(PREFERENCES);
    delayedPlatform.loadLaunchPreferences = vi.fn(async () => {
      controller.abort();
      return PREFERENCES;
    });

    await expect(
      synchronizeLaunchPreferences(delayedPlatform, controller.signal, destination),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(destination.calls).toEqual([]);
  });

  it('cancels while queued behind another preference transaction', async () => {
    let releaseFirst: VoidFunction = () => undefined;
    const firstBankWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const destination: LaunchPreferenceTarget = {
      isolateBankSession: async () => true,
      activateVerifiedSession: async () => true,
      getAppliedReceipt: () => null,
      setLocale: (preferences) => {
        calls.push(`locale:${preferences.revision}`);
        return true;
      },
      applyBankPreferences: async (preferences) => {
        calls.push(`bank:${preferences.revision}`);
        if (preferences.revision === 5) await firstBankWrite;
        return true;
      },
      saveAppliedReceipt: (receipt) => {
        calls.push(`receipt:${receipt.revision}`);
        return true;
      },
    };
    const first = synchronizeLaunchPreferences(
      platform({ ...PREFERENCES, revision: 5 }),
      new AbortController().signal,
      destination,
    );
    await vi.waitFor(() => expect(calls).toContain('bank:5'));
    const queuedController = new AbortController();
    const queued = synchronizeLaunchPreferences(
      platform({ ...PREFERENCES, revision: 4 }),
      queuedController.signal,
      destination,
    );
    queuedController.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['locale:5', 'bank:5']);
    releaseFirst();
    await expect(first).resolves.toBe('applied');
  });
});
