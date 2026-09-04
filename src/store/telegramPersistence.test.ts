import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSeed } from '@/domain/seed';
import type { BankState } from '@/domain/types';

const NOW = '2026-09-01T12:00:00.000Z';
const SCHEMA_VERSION = 4;

function telegramState(telegramId: string, displayName: string): BankState {
  return {
    ...buildSeed(NOW),
    profile: { displayName, telegramId },
  };
}

function envelope(state: BankState): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, state });
}

async function importTelegramPersistence() {
  vi.doMock('@/platform/environment', () => ({ isTelegramMiniApp: () => true }));
  return import('./persistence');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@/platform/environment');
  vi.resetModules();
});

describe('Telegram persistence namespaces', () => {
  it('keeps quarantine ephemeral and rejects malformed or mismatched identities', async () => {
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });
    const persistence = await importTelegramPersistence();

    expect(persistence.getActiveTelegramPersistenceId()).toBeUndefined();
    expect(persistence.loadPersisted()).toEqual({ kind: 'empty' });
    expect(persistence.savePersisted(buildSeed(NOW))).toBe(true);
    expect(setItem).not.toHaveBeenCalled();

    expect(persistence.activateTelegramPersistence('01')).toBe(false);
    expect(persistence.activateTelegramPersistence('../42')).toBe(false);
    expect(persistence.activateTelegramPersistence(undefined)).toBe(false);
    expect(persistence.getActiveTelegramPersistenceId()).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();

    expect(persistence.activateTelegramPersistence('42')).toBe(true);
    expect(persistence.savePersisted(telegramState('43', 'Wrong user'))).toBe(false);
    expect(persistence.savePersisted(telegramState('42', 'Ada'))).toBe(true);
    expect([...storage.keys()]).toEqual(['cometa.bank.tma.user.42']);
  });

  it('migrates the legacy singleton only after the verified identity matches', async () => {
    const legacyState = telegramState('42', 'Ada');
    legacyState.cards[0] = { ...legacyState.cards[0], status: 'frozen' };
    const receipt = {
      version: 2 as const,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: '42',
      revisionEpoch: '0123456789abcdef0123456789abcdef',
      revision: 7,
    };
    const storage = new Map<string, string>([
      ['cometa.bank.tma', envelope(legacyState)],
      ['cometa.bank.tma.locale', 'en'],
      ['cometa.bank.tma.launch-preferences-receipt', JSON.stringify(receipt)],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const persistence = await importTelegramPersistence();

    expect(persistence.activateTelegramPersistence('43')).toBe(true);
    expect(persistence.loadPersisted()).toEqual({ kind: 'empty' });
    expect(persistence.loadLocalePreference()).toBe('ru');
    expect(persistence.loadAppliedLaunchPreferencesReceipt()).toBeNull();
    expect([...storage.keys()].some((key) => key.includes('.user.43'))).toBe(false);

    expect(persistence.activateTelegramPersistence('42')).toBe(true);
    expect(persistence.loadPersisted()).toEqual({ kind: 'ok', state: legacyState });
    expect(persistence.loadLocalePreference()).toBe('en');
    expect(persistence.loadAppliedLaunchPreferencesReceipt()).toEqual(receipt);
    expect(storage.get('cometa.bank.tma.user.42')).toBe(envelope(legacyState));
    expect(storage.get('cometa.bank.tma.user.42.locale')).toBe('en');

    persistence.quarantineTelegramPersistence();
    expect(persistence.loadPersisted()).toEqual({ kind: 'empty' });
    expect(storage.get('cometa.bank.tma.user.42')).toBe(envelope(legacyState));

    expect(persistence.activateTelegramPersistence('42')).toBe(true);
    expect(persistence.loadPersisted()).toEqual({ kind: 'ok', state: legacyState });
  });

  it('keeps two document listeners scoped to their own verified Telegram users', async () => {
    const stateA = telegramState('41', 'Window A');
    const stateB = telegramState('42', 'Window B');
    const receiptA = {
      version: 2 as const,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: '41',
      revisionEpoch: '11111111111111111111111111111111',
      revision: 3,
    };
    const receiptB = {
      version: 2 as const,
      bankSchemaVersion: SCHEMA_VERSION,
      telegramId: '42',
      revisionEpoch: '22222222222222222222222222222222',
      revision: 5,
    };
    const storage = new Map<string, string>([
      ['cometa.bank.tma.user.41', envelope(stateA)],
      ['cometa.bank.tma.user.41.locale', 'ru'],
      ['cometa.bank.tma.user.41.launch-preferences-receipt', JSON.stringify(receiptA)],
      ['cometa.bank.tma.user.42', envelope(stateB)],
      ['cometa.bank.tma.user.42.locale', 'en'],
      ['cometa.bank.tma.user.42.launch-preferences-receipt', JSON.stringify(receiptB)],
    ]);
    const storageListeners: Array<(event: StorageEvent) => void> = [];
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') storageListeners.push(listener);
      }),
      removeEventListener: vi.fn(),
    });

    const persistenceA = await importTelegramPersistence();
    persistenceA.activateTelegramPersistence('41');
    expect(persistenceA.loadAppliedLaunchPreferencesReceipt()).toEqual(receiptA);
    const bankA = vi.fn();
    const localeA = vi.fn();
    persistenceA.onCrossTabChange(bankA);
    persistenceA.onLocalePreferenceChange(localeA);

    vi.resetModules();
    const persistenceB = await importTelegramPersistence();
    persistenceB.activateTelegramPersistence('42');
    expect(persistenceB.loadAppliedLaunchPreferencesReceipt()).toEqual(receiptB);
    expect(persistenceA.loadAppliedLaunchPreferencesReceipt()).toEqual(receiptA);
    const updatedA = { ...stateA, primaryCurrency: 'GEL' as const };
    const updatedB = { ...stateB, primaryCurrency: 'USD' as const };
    expect(persistenceA.savePersisted(updatedA)).toBe(true);
    expect(persistenceB.savePersisted(updatedB)).toBe(true);
    expect(JSON.parse(storage.get('cometa.bank.tma.user.41') ?? '{}')).toMatchObject({
      state: { primaryCurrency: 'GEL', profile: { telegramId: '41' } },
    });
    expect(JSON.parse(storage.get('cometa.bank.tma.user.42') ?? '{}')).toMatchObject({
      state: { primaryCurrency: 'USD', profile: { telegramId: '42' } },
    });
    const bankB = vi.fn();
    const localeB = vi.fn();
    persistenceB.onCrossTabChange(bankB);
    persistenceB.onLocalePreferenceChange(localeB);

    for (const listener of storageListeners) {
      listener({ key: 'cometa.bank.tma.user.41', newValue: envelope(updatedA) } as StorageEvent);
      listener({ key: 'cometa.bank.tma.user.41.locale', newValue: 'ru' } as StorageEvent);
    }
    expect(bankA).toHaveBeenCalledWith(updatedA);
    expect(localeA).toHaveBeenCalledWith('ru');
    expect(bankB).not.toHaveBeenCalled();
    expect(localeB).not.toHaveBeenCalled();

    bankA.mockClear();
    localeA.mockClear();
    for (const listener of storageListeners) {
      listener({ key: 'cometa.bank.tma.user.42', newValue: envelope(updatedB) } as StorageEvent);
      listener({ key: 'cometa.bank.tma.user.42.locale', newValue: 'en' } as StorageEvent);
    }
    expect(bankA).not.toHaveBeenCalled();
    expect(localeA).not.toHaveBeenCalled();
    expect(bankB).toHaveBeenCalledWith(updatedB);
    expect(localeB).toHaveBeenCalledWith('en');
  });

  it('rejects a forged cross-document state stored under the active user key', async () => {
    const forged = telegramState('42', 'Wrong user');
    const storage = new Map<string, string>([
      ['cometa.bank.tma.user.41', envelope(forged)],
    ]);
    let listener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((_type: string, callback: (event: StorageEvent) => void) => {
        listener = callback;
      }),
      removeEventListener: vi.fn(),
    });
    const persistence = await importTelegramPersistence();
    persistence.activateTelegramPersistence('41');
    const callback = vi.fn();
    persistence.onCrossTabChange(callback);

    expect(persistence.loadPersisted()).toEqual({ kind: 'corrupted' });
    listener?.({ key: 'cometa.bank.tma.user.41', newValue: envelope(forged) } as StorageEvent);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps a pending mutation on same-ID reactivation and aborts it on an account switch', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const persistence = await importTelegramPersistence();
    persistence.activateTelegramPersistence('41');

    let releaseLock: VoidFunction = () => undefined;
    let lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (_name: string, _options: LockOptions, callback: () => unknown) => {
            await lockGate;
            return callback();
          },
        ),
      },
    });

    const sameIdentityWork = vi.fn(() => 'same user');
    const sameIdentityMutation = persistence.withPersistenceLock(sameIdentityWork);
    persistence.activateTelegramPersistence('41');
    releaseLock();

    await expect(sameIdentityMutation).resolves.toBe('same user');
    expect(sameIdentityWork).toHaveBeenCalledOnce();

    lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const switchedIdentityWork = vi.fn(() => 'wrong user');
    const switchedIdentityMutation = persistence.withPersistenceLock(switchedIdentityWork);
    persistence.activateTelegramPersistence('42');
    releaseLock();

    await expect(switchedIdentityMutation).rejects.toMatchObject({ name: 'AbortError' });
    expect(switchedIdentityWork).not.toHaveBeenCalled();
  });

  it('never falls back into a different Telegram namespace after lock acquisition rejects', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const persistence = await importTelegramPersistence();
    persistence.activateTelegramPersistence('41');

    let rejectLock: ((reason: Error) => void) | undefined;
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          () =>
            new Promise<never>((_resolve, reject) => {
              rejectLock = reject;
            }),
        ),
      },
    });

    const staleWork = vi.fn(() => 'wrong user');
    const mutation = persistence.withPersistenceLock(staleWork);
    persistence.activateTelegramPersistence('42');
    rejectLock?.(new DOMException('storage access denied', 'SecurityError'));

    await expect(mutation).rejects.toMatchObject({ name: 'AbortError' });
    expect(staleWork).not.toHaveBeenCalled();
    expect(persistence.getActiveTelegramPersistenceId()).toBe('42');
  });
});
