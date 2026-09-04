import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BankState } from '@/domain/types';
import { balanceOf } from '@/domain/ledger';
import { buildSeed } from '@/domain/seed';
import { applyTransfer } from '@/domain/transfer';
import { SCHEMA_VERSION } from './persistence';

const TODAY = new Date().toISOString().slice(0, 10);
const MIGRATION_NOW = '2026-09-02T12:00:00.000Z';
const RATE_ROWS = [
  { date: TODAY, base: 'USD', quote: 'EUR', rate: 0.86107 },
  { date: TODAY, base: 'USD', quote: 'RUB', rate: 86.24 },
  { date: TODAY, base: 'USD', quote: 'KZT', rate: 462.27 },
  { date: TODAY, base: 'USD', quote: 'THB', rate: 33.136 },
  { date: TODAY, base: 'USD', quote: 'VND', rate: 26044 },
  { date: TODAY, base: 'USD', quote: 'IDR', rate: 17710 },
  { date: TODAY, base: 'USD', quote: 'GEL', rate: 2.6121 },
];

function okResponse(date = TODAY): Response {
  return new Response(JSON.stringify(RATE_ROWS.map((row) => ({ ...row, date }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withFreshRates(state: BankState, nowISO: string): BankState {
  return {
    ...state,
    exchangeRates: {
      ...state.exchangeRates,
      source: 'frankfurter',
      asOf: nowISO.slice(0, 10),
      fetchedAt: nowISO,
    },
  };
}

async function importTelegramBankStore() {
  // This file imports the web store at module scope for most tests. A fresh
  // graph is required so persistence reads the Telegram environment mock.
  vi.resetModules();
  vi.doMock('@/platform/environment', () => ({ isTelegramMiniApp: () => true }));
  return import('./bankStore');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('@/platform/environment');
  vi.resetModules();
});

describe('useBankStore schema migration', () => {
  it('reseeds a schema-v3 install instead of keeping the pre-statement demo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MIGRATION_NOW);
    const freshSeed = buildSeed(MIGRATION_NOW);
    const legacyState: BankState = {
      ...freshSeed,
      primaryCurrency: 'GEL',
      transactions: freshSeed.transactions.map((transaction, index) =>
        index === freshSeed.transactions.length - 1
          ? { ...transaction, counterparty: 'Legacy generic merchant' }
          : transaction,
      ),
      profile: { displayName: 'Legacy user', telegramId: '42' },
      recentTransferIds: ['ct_legacy_schema_v3'],
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: 3, state: legacyState })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    const { useBankStore } = await import('./bankStore');
    const next = useBankStore.getState();

    expect(legacyState.accounts).toHaveLength(4);
    expect(next.recoveredFromCorruption).toBe(true);
    expect(next.primaryCurrency).toBe(freshSeed.primaryCurrency);
    expect(next.accounts).toEqual(freshSeed.accounts);
    expect(next.transactions).toEqual(freshSeed.transactions);
    expect(next.profile).toEqual(freshSeed.profile);
    expect(next.recentTransferIds).toEqual([]);
  });
});

describe('useBankStore initial persistence lifecycle', () => {
  it('contains an expected namespace-switch abort during delayed first-run persistence', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    let releaseFirstLock: VoidFunction = () => undefined;
    let firstRequest: Promise<unknown> | undefined;
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          (_name: string, _options: LockOptions, callback: () => unknown) => {
            firstRequest = new Promise<void>((resolve) => {
              releaseFirstLock = resolve;
            }).then(callback);
            return firstRequest;
          },
        ),
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await importTelegramBankStore();
    const persistence = await import('./persistence');
    expect(persistence.activateTelegramPersistence('42')).toBe(true);
    releaseFirstLock();
    await firstRequest?.catch(() => undefined);
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs an unexpected first-run persistence rejection with context', async () => {
    const failure = new Error('lock callback failed');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (_name: string, _options: LockOptions, callback: () => unknown) => {
            callback();
            throw failure;
          },
        ),
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await importTelegramBankStore();
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[cometa] initial persistence synchronization failed',
        failure,
      );
    });
  });
});

describe('useBankStore exchange rates', () => {
  it('updates the primary display currency without changing account currencies', async () => {
    const { useBankStore } = await import('./bankStore');
    const before = useBankStore.getState().accounts.map((account) => account.currency);

    await useBankStore.getState().setPrimaryCurrency('GEL');

    expect(useBankStore.getState().primaryCurrency).toBe('GEL');
    expect(useBankStore.getState().accounts.map((account) => account.currency)).toEqual(before);
  });

  it('applies validated Telegram preferences without changing the ledger', async () => {
    const storage = new Map<string, string>();
    const seed = buildSeed(new Date().toISOString());
    storage.set('cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: seed }));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await import('./bankStore');
    const ledgerBefore = useBankStore.getState().transactions;

    await expect(
      useBankStore.getState().applyLaunchPreferences({
        version: 1,
        revisionEpoch: '0123456789abcdef0123456789abcdef',
        revision: 3,
        locale: 'en',
        primaryCurrency: 'GEL',
        displayName: 'Ada Lovelace',
        telegramId: '9007199254740993',
      }),
    ).resolves.toBe(true);

    expect(useBankStore.getState()).toMatchObject({
      primaryCurrency: 'GEL',
      profile: { displayName: 'Ada Lovelace', telegramId: '9007199254740993' },
    });
    expect(useBankStore.getState().transactions).toEqual(ledgerBefore);
  });

  it('reseeds user-specific mock data when the validated Telegram account changes', async () => {
    const storage = new Map<string, string>();
    const nowISO = new Date().toISOString();
    const seed = {
      ...buildSeed(nowISO),
      profile: { displayName: 'Ada', telegramId: '41' },
    };
    const checking = seed.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = seed.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const changed = applyTransfer(seed, {
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 100,
      clientTransferId: 'ct_previous_telegram_user',
      nowISO,
    });
    if (!changed.ok) throw new Error(`Transfer fixture failed: ${changed.error}`);
    storage.set(
      'cometa.bank',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: changed.state }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await import('./bankStore');

    await useBankStore.getState().applyLaunchPreferences({
      version: 1,
      revisionEpoch: '0123456789abcdef0123456789abcdef',
      revision: 1,
      locale: 'en',
      primaryCurrency: 'USD',
      displayName: 'Grace',
      telegramId: '42',
    });

    const next = useBankStore.getState();
    expect(next.profile).toEqual({ displayName: 'Grace', telegramId: '42' });
    expect(next.primaryCurrency).toBe('USD');
    expect(next.recentTransferIds).not.toContain('ct_previous_telegram_user');
    expect(next.transactions).toHaveLength(buildSeed(nowISO).transactions.length);
  });

  it('isolates a different local Telegram session before remote bootstrap completes', async () => {
    const storage = new Map<string, string>();
    const state = {
      ...buildSeed(new Date().toISOString()),
      profile: { displayName: 'Ada', telegramId: '41' },
      recentTransferIds: ['ct_previous_telegram_session'],
    };
    storage.set(
      'cometa.bank.tma.user.41',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await importTelegramBankStore();

    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('41'),
    ).resolves.toBe(true);
    await expect(useBankStore.getState().isolateTelegramSession('42')).resolves.toBe(false);

    expect(useBankStore.getState().profile.telegramId).toBeUndefined();
    expect(useBankStore.getState().recentTransferIds).toEqual([]);
    expect(
      JSON.parse(storage.get('cometa.bank.tma.user.41') ?? '{}') as { state?: BankState },
    ).toMatchObject({ state: { profile: state.profile, recentTransferIds: state.recentTransferIds } });
  });

  it('restores the exact prior snapshot after a transiently unavailable Telegram identity', async () => {
    const storage = new Map<string, string>();
    const base = {
      ...buildSeed(new Date().toISOString()),
      profile: { displayName: 'Prior user', telegramId: '41' },
    };
    const checking = base.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = base.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const transferred = applyTransfer(base, {
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 12_345,
      clientTransferId: 'ct_previous_telegram_session',
      nowISO: new Date().toISOString(),
    });
    if (!transferred.ok) throw new Error(`Transfer fixture failed: ${transferred.error}`);
    const state = {
      ...transferred.state,
      cards: transferred.state.cards.map((card, index) =>
        index === 0 ? { ...card, status: 'frozen' as const } : card,
      ),
    };
    storage.set(
      'cometa.bank.tma.user.41',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
    );
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });
    const { useBankStore } = await importTelegramBankStore();
    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('41'),
    ).resolves.toBe(true);
    const exactSnapshot = JSON.parse(JSON.stringify(state)) as BankState;

    const isolation = useBankStore.getState().isolateTelegramSession(undefined);

    expect(useBankStore.getState().profile.telegramId).toBeUndefined();
    expect(useBankStore.getState().recentTransferIds).toEqual([]);
    await expect(isolation).resolves.toBe(false);
    expect(setItem).not.toHaveBeenCalled();

    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('41'),
    ).resolves.toBe(true);
    expect(useBankStore.getState()).toMatchObject(exactSnapshot);
    expect(storage.get('cometa.bank.tma.user.41')).toBe(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
    );
  });

  it('applies verified preferences after unavailable identity quarantine', async () => {
    const storage = new Map<string, string>();
    const state = {
      ...buildSeed(new Date().toISOString()),
      profile: { displayName: 'Prior user', telegramId: '41' },
      recentTransferIds: ['ct_previous_telegram_session'],
    };
    storage.set(
      'cometa.bank.tma.user.41',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await importTelegramBankStore();

    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('41'),
    ).resolves.toBe(true);
    await expect(useBankStore.getState().isolateTelegramSession(undefined)).resolves.toBe(false);
    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('42'),
    ).resolves.toBe(false);
    await expect(
      useBankStore.getState().applyLaunchPreferences({
        version: 1,
        revisionEpoch: '0123456789abcdef0123456789abcdef',
        revision: 1,
        locale: 'en',
        primaryCurrency: 'USD',
        displayName: 'Recovered user',
        telegramId: '42',
      }),
    ).resolves.toBe(true);

    expect(useBankStore.getState()).toMatchObject({
      primaryCurrency: 'USD',
      profile: { displayName: 'Recovered user', telegramId: '42' },
    });
    expect(useBankStore.getState().recentTransferIds).toEqual([]);
    const saved = JSON.parse(storage.get('cometa.bank.tma.user.42') ?? '{}') as {
      state?: BankState;
    };
    expect(saved.state?.profile).toEqual({ displayName: 'Recovered user', telegramId: '42' });
    expect(
      JSON.parse(storage.get('cometa.bank.tma.user.41') ?? '{}') as { state?: BankState },
    ).toMatchObject({ state: { profile: state.profile } });
  });

  it('reports an already aligned Telegram identity for receipt reuse', async () => {
    const storage = new Map<string, string>();
    const state = {
      ...buildSeed(new Date().toISOString()),
      profile: { displayName: 'Current user', telegramId: '42' },
    };
    storage.set(
      'cometa.bank.tma.user.42',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await importTelegramBankStore();

    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('42'),
    ).resolves.toBe(true);
    await expect(useBankStore.getState().isolateTelegramSession('42')).resolves.toBe(true);
    expect(useBankStore.getState().profile).toEqual(state.profile);
  });

  it('preserves a dirty same-ID mutation across verified bootstrap and retries its save', async () => {
    const nowISO = new Date().toISOString();
    const state = {
      ...buildSeed(nowISO),
      profile: { displayName: 'Current user', telegramId: '42' },
    };
    const storage = new Map<string, string>([
      [
        'cometa.bank.tma.user.42',
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }),
      ],
    ]);
    let rejectWrites = false;
    const setItem = vi.fn((key: string, value: string) => {
      if (rejectWrites) throw new DOMException('quota reached', 'QuotaExceededError');
      storage.set(key, value);
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });
    const { useBankStore } = await importTelegramBankStore();

    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('42'),
    ).resolves.toBe(true);
    const cardId = useBankStore.getState().cards[0]?.id;
    if (cardId === undefined) throw new Error('Seed fixture has no card');

    rejectWrites = true;
    await useBankStore.getState().toggleCardFreeze(cardId);
    expect(useBankStore.getState().cards[0]?.status).toBe('frozen');
    await expect(useBankStore.getState().isolateTelegramSession('42')).resolves.toBe(false);
    await expect(
      useBankStore.getState().activateVerifiedTelegramSession('42'),
    ).resolves.toBe(false);
    expect(useBankStore.getState().cards[0]?.status).toBe('frozen');

    rejectWrites = false;
    await expect(
      useBankStore.getState().applyLaunchPreferences({
        version: 1,
        revisionEpoch: '0123456789abcdef0123456789abcdef',
        revision: 2,
        locale: 'en',
        primaryCurrency: state.primaryCurrency,
        displayName: state.profile.displayName,
        telegramId: '42',
      }),
    ).resolves.toBe(true);

    const saved = JSON.parse(storage.get('cometa.bank.tma.user.42') ?? '{}') as {
      state?: BankState;
    };
    expect(saved.state?.cards[0]?.status).toBe('frozen');
  });

  it('preserves Telegram currency and profile through resetDemo', async () => {
    const storage = new Map<string, string>();
    const seed = buildSeed(new Date().toISOString());
    storage.set('cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: seed }));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const { useBankStore } = await import('./bankStore');
    const preferences = {
      version: 1 as const,
      revisionEpoch: '0123456789abcdef0123456789abcdef',
      revision: 3,
      locale: 'en' as const,
      primaryCurrency: 'GEL' as const,
      displayName: 'Ada Lovelace',
      telegramId: '9007199254740993',
    };

    await useBankStore.getState().applyLaunchPreferences(preferences);
    await useBankStore.getState().resetDemo();

    expect(useBankStore.getState().primaryCurrency).toBe('GEL');
    expect(useBankStore.getState().profile).toEqual({
      displayName: 'Ada Lovelace',
      telegramId: '9007199254740993',
    });
  });

  it('stores one complete live snapshot', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { useBankStore } = await import('./bankStore');

    await expect(useBankStore.getState().refreshRates(true)).resolves.toBe('updated');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useBankStore.getState().exchangeRates).toMatchObject({
      base: 'USD',
      asOf: TODAY,
      source: 'frankfurter',
      rates: { USD: '1', KZT: '462.27', GEL: '2.6121' },
    });
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('deduplicates concurrent refreshes from React StrictMode', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { useBankStore } = await import('./bankStore');

    const first = useBankStore.getState().refreshRates(true);
    const second = useBankStore.getState().refreshRates(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(okResponse());
    await expect(Promise.all([first, second])).resolves.toEqual(['updated', 'updated']);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('keeps the latest refresh loading while an older generation finishes persistence', async () => {
    const fetchResolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          fetchResolvers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    let releaseFirstLock: (() => void) | undefined;
    let lockCalls = 0;
    const requestLock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
      lockCalls += 1;
      if (lockCalls === 1) {
        return new Promise<unknown>((resolve, reject) => {
          releaseFirstLock = () => {
            Promise.resolve(callback()).then(resolve, reject);
          };
        });
      }
      return Promise.resolve(callback());
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    const { useBankStore } = await import('./bankStore');
    const first = useBankStore.getState().refreshRates(true);
    fetchResolvers[0]?.(okResponse());
    await vi.waitFor(() => expect(requestLock).toHaveBeenCalledOnce());

    const second = useBankStore.getState().refreshRates(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    releaseFirstLock?.();
    await expect(first).resolves.toBe('updated');
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    fetchResolvers[1]?.(okResponse());
    await expect(second).resolves.toBe('updated');
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('uses a fresh live cache without a request', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { useBankStore } = await import('./bankStore');
    const current = useBankStore.getState();
    useBankStore.setState({
      exchangeRates: {
        ...current.exchangeRates,
        source: 'frankfurter',
        fetchedAt: new Date().toISOString(),
      },
    });

    await expect(useBankStore.getState().refreshRates()).resolves.toBe('cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes a recently fetched cache when its provider date is stale', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { useBankStore } = await import('./bankStore');
    const current = useBankStore.getState();
    useBankStore.setState({
      exchangeRates: {
        ...current.exchangeRates,
        source: 'frankfurter',
        asOf: '2001-01-01',
        fetchedAt: new Date().toISOString(),
      },
    });

    await expect(useBankStore.getState().refreshRates()).resolves.toBe('updated');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the last complete snapshot when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { useBankStore } = await import('./bankStore');
    const before = useBankStore.getState().exchangeRates;

    await expect(useBankStore.getState().refreshRates(true)).resolves.toBe('failed');

    expect(useBankStore.getState().exchangeRates).toEqual(before);
    expect(useBankStore.getState().ratesStatus).toBe('error');
  });

  it('derives a fresh rates status when a cross-tab update supplies a fresh live snapshot', async () => {
    const nowISO = `${TODAY}T12:00:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const freshState: BankState = {
      ...initial,
      exchangeRates: {
        ...initial.exchangeRates,
        source: 'frankfurter',
        asOf: TODAY,
        fetchedAt: nowISO,
      },
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(
        (type: string, listener: (event: StorageEvent) => void) => {
          if (type === 'storage') storageListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const freshEnvelope = JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: freshState });
    storage.set('cometa.bank', freshEnvelope);

    storageListener?.({ key: 'cometa.bank', newValue: freshEnvelope } as StorageEvent);

    expect(useBankStore.getState().exchangeRates).toEqual(freshState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('preserves a local rate error when a cross-tab update has no fresh live snapshot', async () => {
    const nowISO = `${TODAY}T12:00:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const incomingState: BankState = { ...initial, primaryCurrency: 'GEL' };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(
        (type: string, listener: (event: StorageEvent) => void) => {
          if (type === 'storage') storageListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const incomingEnvelope = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      state: incomingState,
    });
    storage.set('cometa.bank', incomingEnvelope);

    storageListener?.({ key: 'cometa.bank', newValue: incomingEnvelope } as StorageEvent);

    expect(useBankStore.getState().primaryCurrency).toBe('GEL');
    expect(useBankStore.getState().exchangeRates).toEqual(incomingState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('error');
  });

  it('preserves loading while a local rate refresh remains in flight during a cross-tab update', async () => {
    const nowISO = `${TODAY}T12:00:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const freshState: BankState = {
      ...initial,
      exchangeRates: {
        ...initial.exchangeRates,
        source: 'frankfurter',
        asOf: TODAY,
        fetchedAt: nowISO,
      },
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(
        (type: string, listener: (event: StorageEvent) => void) => {
          if (type === 'storage') storageListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const { useBankStore } = await import('./bankStore');
    const refresh = useBankStore.getState().refreshRates(true);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    const freshEnvelope = JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: freshState });
    storage.set('cometa.bank', freshEnvelope);
    storageListener?.({ key: 'cometa.bank', newValue: freshEnvelope } as StorageEvent);

    expect(useBankStore.getState().exchangeRates).toEqual(freshState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    resolveFetch?.(okResponse());
    await expect(refresh).resolves.toMatch(/updated|cached/);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('reports a forced refresh failure when only an equal fresh snapshot remains usable', async () => {
    const nowISO = `${TODAY}T12:00:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    let rejectFetch: ((reason: Error) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { useBankStore } = await import('./bankStore');
    const initial = useBankStore.getState().exchangeRates;
    const freshSnapshot = {
      ...initial,
      source: 'frankfurter' as const,
      asOf: TODAY,
      fetchedAt: nowISO,
    };
    useBankStore.setState({ exchangeRates: freshSnapshot, ratesStatus: 'fresh' });

    const refresh = useBankStore.getState().refreshRates(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    useBankStore.setState({ exchangeRates: { ...freshSnapshot } });
    expect(useBankStore.getState().exchangeRates).not.toBe(freshSnapshot);
    rejectFetch?.(new Error('offline'));

    await expect(refresh).resolves.toBe('failed');
    expect(useBankStore.getState().exchangeRates).toEqual(freshSnapshot);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('keeps a cross-tab fresh snapshot usable when the local in-flight refresh rejects', async () => {
    const nowISO = `${TODAY}T12:00:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const freshState: BankState = {
      ...initial,
      exchangeRates: {
        ...initial.exchangeRates,
        source: 'frankfurter',
        asOf: TODAY,
        fetchedAt: nowISO,
      },
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(
        (type: string, listener: (event: StorageEvent) => void) => {
          if (type === 'storage') storageListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    });
    let rejectFetch: ((reason: Error) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );

    const { useBankStore } = await import('./bankStore');
    const refresh = useBankStore.getState().refreshRates(true);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    const freshEnvelope = JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: freshState });
    storage.set('cometa.bank', freshEnvelope);
    storageListener?.({ key: 'cometa.bank', newValue: freshEnvelope } as StorageEvent);
    expect(useBankStore.getState().exchangeRates).toEqual(freshState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    rejectFetch?.(new Error('offline'));
    await expect(refresh).resolves.toBe('cached');

    expect(useBankStore.getState().exchangeRates).toEqual(freshState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('preserves loading through resetDemo until the latest refresh settles', async () => {
    const initial = buildSeed(new Date().toISOString());
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('navigator', {});
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const { useBankStore } = await import('./bankStore');
    const refresh = useBankStore.getState().refreshRates(true);
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    await useBankStore.getState().resetDemo();
    expect(useBankStore.getState().ratesStatus).toBe('loading');

    resolveFetch?.(okResponse());
    await expect(refresh).resolves.toBe('updated');
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('preserves a rate error through resetDemo when its retained snapshot is not fresh', async () => {
    const initial = buildSeed(new Date().toISOString());
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('navigator', {});

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });

    await useBankStore.getState().resetDemo();

    expect(useBankStore.getState().exchangeRates.source).toBe('fallback');
    expect(useBankStore.getState().ratesStatus).toBe('error');
  });

  it('contains settlement calculation failures without an unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', {});
    const { useBankStore } = await import('./bankStore');
    const current = useBankStore.getState();
    useBankStore.setState({
      accounts: current.accounts.map((account) =>
        account.type === 'savings'
          ? { ...account, accrualAnchor: '0001-01-01T00:00:00.000Z' }
          : account,
      ),
    });
    const transactionsBefore = useBankStore.getState().transactions;

    await expect(useBankStore.getState().settleNow()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '[cometa] interest settlement failed',
      expect.objectContaining({ message: 'Transaction amount must be a safe integer' }),
    );
    expect(useBankStore.getState().transactions).toBe(transactionsBefore);
    errorSpy.mockRestore();
  });

  it('derives fresh rates status when settleNow adopts a missed cross-tab snapshot with no accrual', async () => {
    const nowISO = '2026-09-01T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const settledToday: BankState = {
      ...initial,
      accounts: initial.accounts.map((account) =>
        account.type === 'savings' ? { ...account, accrualAnchor: nowISO } : account,
      ),
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: settledToday })],
    ]);
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const checking = settledToday.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = settledToday.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const transfer = applyTransfer(settledToday, {
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 100,
      clientTransferId: 'ct_newer_persisted_no_accrual',
      nowISO,
    });
    if (!transfer.ok) throw new Error(`Transfer fixture failed: ${transfer.error}`);
    const missedCrossTabState = withFreshRates(transfer.state, nowISO);
    storage.set(
      'cometa.bank',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: missedCrossTabState }),
    );

    await useBankStore.getState().settleNow();

    expect(useBankStore.getState().recentTransferIds).toContain('ct_newer_persisted_no_accrual');
    expect(useBankStore.getState().transactions).toEqual(missedCrossTabState.transactions);
    expect(useBankStore.getState().nextSeq).toBe(missedCrossTabState.nextSeq);
    expect(useBankStore.getState().exchangeRates).toEqual(missedCrossTabState.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('derives fresh rates status when accrued settlement commits a missed cross-tab snapshot', async () => {
    const createdISO = '2026-09-01T12:00:00.000Z';
    const nowISO = '2026-09-02T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(createdISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const missedCrossTabState = withFreshRates(initial, nowISO);
    storage.set(
      'cometa.bank',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: missedCrossTabState }),
    );
    const interestRowsBefore = initial.transactions.filter(
      (transaction) => transaction.kind === 'interest',
    ).length;

    await useBankStore.getState().settleNow();

    const current = useBankStore.getState();
    expect(current.transactions.filter((transaction) => transaction.kind === 'interest')).toHaveLength(
      interestRowsBefore + 1,
    );
    expect(current.exchangeRates).toEqual(missedCrossTabState.exchangeRates);
    expect(current.ratesStatus).toBe('fresh');
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('resyncs a newer persisted state when the primary currency is already selected', async () => {
    const nowISO = '2026-09-01T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const checking = initial.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = initial.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const transfer = applyTransfer(initial, {
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 100,
      clientTransferId: 'ct_newer_persisted_same_currency',
      nowISO,
    });
    if (!transfer.ok) throw new Error(`Transfer fixture failed: ${transfer.error}`);
    const missedCrossTabState = withFreshRates(transfer.state, nowISO);
    storage.set(
      'cometa.bank',
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        state: {
          ...missedCrossTabState,
          settleNow: 'replace the store action',
          ratesStatus: 'error',
        },
      }),
    );

    await useBankStore.getState().setPrimaryCurrency(initial.primaryCurrency);

    const current = useBankStore.getState();
    expect(current.recentTransferIds).toContain('ct_newer_persisted_same_currency');
    expect(current.transactions).toEqual(transfer.state.transactions);
    expect(current.nextSeq).toBe(transfer.state.nextSeq);
    expect(current.settleNow).toBeTypeOf('function');
    expect(current.ratesStatus).toBe('fresh');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('resyncs a newer persisted balance when a stale-tab transfer is rejected', async () => {
    const nowISO = '2026-09-01T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});

    const initial = buildSeed(nowISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const checking = initial.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = initial.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const initialBalance = balanceOf(initial, checking.id);
    const newer = applyTransfer(initial, {
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: initialBalance - 100,
      clientTransferId: 'ct_newer_persisted_low_balance',
      nowISO,
    });
    if (!newer.ok) throw new Error(`Transfer fixture failed: ${newer.error}`);
    const missedCrossTabState = withFreshRates(newer.state, nowISO);
    storage.set(
      'cometa.bank',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: missedCrossTabState }),
    );

    const rejected = await useBankStore.getState().transfer({
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 200,
      clientTransferId: 'ct_rejected_after_rebase',
    });

    expect(rejected).toEqual({ ok: false, error: 'insufficient_funds' });
    expect(useBankStore.getState().transactions).toEqual(missedCrossTabState.transactions);
    expect(balanceOf(useBankStore.getState(), checking.id)).toBe(100);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('serializes concurrent transfers from two store instances without a lost update', async () => {
    const storage = new Map<string, string>();
    storage.set(
      'cometa.bank',
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        state: buildSeed(new Date().toISOString()),
      }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    let lockTail: Promise<unknown> = Promise.resolve();
    const requestLock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
      const result = lockTail.then(() => callback());
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    const firstModule = await import('./bankStore');
    const firstStore = firstModule.useBankStore;
    vi.resetModules();
    const secondModule = await import('./bankStore');
    const secondStore = secondModule.useBankStore;

    const initialEnvelope = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    const checking = initialEnvelope.state.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = initialEnvelope.state.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');
    const initialBalance = balanceOf(initialEnvelope.state, checking.id);

    const [first, second] = await Promise.all([
      firstStore.getState().transfer({
        fromAccountId: checking.id,
        toContactId: contact.id,
        amountMinor: 100,
        clientTransferId: 'ct_tab_one',
      }),
      secondStore.getState().transfer({
        fromAccountId: checking.id,
        toContactId: contact.id,
        amountMinor: 200,
        clientTransferId: 'ct_tab_two',
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const finalEnvelope = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    expect(finalEnvelope.state.recentTransferIds).toEqual(
      expect.arrayContaining(['ct_tab_one', 'ct_tab_two']),
    );
    expect(balanceOf(finalEnvelope.state, checking.id)).toBe(initialBalance - 300);
    expect(requestLock).toHaveBeenCalledTimes(2);
  });

  it('rebases a delayed rate refresh so it cannot erase another tab transfer', async () => {
    const storage = new Map<string, string>();
    storage.set(
      'cometa.bank',
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        state: buildSeed(new Date().toISOString()),
      }),
    );
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    let lockTail: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
          const result = lockTail.then(() => callback());
          lockTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        }),
      },
    });

    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const firstStore = (await import('./bankStore')).useBankStore;
    vi.resetModules();
    const secondStore = (await import('./bankStore')).useBankStore;
    const initial = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    const checking = initial.state.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = initial.state.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');

    const refresh = secondStore.getState().refreshRates(true);
    const transfer = await firstStore.getState().transfer({
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 100,
      clientTransferId: 'ct_before_delayed_refresh',
    });
    expect(transfer.ok).toBe(true);

    resolveFetch?.(okResponse());
    await expect(refresh).resolves.toBe('updated');

    const finalEnvelope = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    expect(finalEnvelope.state.recentTransferIds).toContain('ct_before_delayed_refresh');
    expect(finalEnvelope.state.exchangeRates.source).toBe('frankfurter');
  });

  it('keeps in-memory state authoritative after a persistence write fails', async () => {
    const storage = new Map<string, string>();
    const seed = buildSeed(new Date().toISOString());
    storage.set('cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: seed }));
    let failNextWrite = true;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new DOMException('quota reached', 'QuotaExceededError');
        }
        storage.set(key, value);
      }),
    });

    const { useBankStore } = await import('./bankStore');
    const checking = seed.accounts.find(
      (account) => account.currency === 'KZT' && account.type === 'checking',
    );
    const contact = seed.contacts[0];
    if (!checking || !contact) throw new Error('Seed fixture is incomplete');

    const outcome = await useBankStore.getState().transfer({
      fromAccountId: checking.id,
      toContactId: contact.id,
      amountMinor: 100,
      clientTransferId: 'ct_survives_quota_error',
    });
    expect(outcome.ok).toBe(true);

    await useBankStore.getState().setPrimaryCurrency('GEL');

    expect(useBankStore.getState().recentTransferIds).toContain('ct_survives_quota_error');
    const persisted = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    expect(persisted.state.recentTransferIds).toContain('ct_survives_quota_error');
    expect(persisted.state.primaryCurrency).toBe('GEL');
  });

  it('does not replace a newer cross-tab rate snapshot with a delayed response', async () => {
    const storage = new Map<string, string>();
    const state = buildSeed(new Date().toISOString());
    storage.set('cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }));
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const { useBankStore } = await import('./bankStore');
    const refresh = useBankStore.getState().refreshRates(true);

    const envelope = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    envelope.state.exchangeRates = {
      ...envelope.state.exchangeRates,
      source: 'frankfurter',
      asOf: TODAY,
      fetchedAt: new Date().toISOString(),
    };
    storage.set('cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: envelope.state }));

    const yesterday = new Date(`${TODAY}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    resolveFetch?.(okResponse(yesterday.toISOString().slice(0, 10)));

    await expect(refresh).resolves.toBe('cached');
    expect(useBankStore.getState().exchangeRates.asOf).toBe(TODAY);
    const persisted = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    expect(persisted.state.exchangeRates.asOf).toBe(TODAY);
  });

  it('reports failure when an older provider snapshot cannot refresh the retained stale cache', async () => {
    const now = new Date(`${TODAY}T18:00:00.000Z`);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const yesterday = new Date(`${TODAY}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const state = buildSeed(now.toISOString());
    state.exchangeRates = {
      ...state.exchangeRates,
      source: 'frankfurter',
      asOf: TODAY,
      fetchedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString(),
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(yesterday.toISOString().slice(0, 10))));

    const { useBankStore } = await import('./bankStore');

    await expect(useBankStore.getState().refreshRates(true)).resolves.toBe('failed');
    expect(useBankStore.getState().exchangeRates.asOf).toBe(TODAY);
    expect(useBankStore.getState().ratesStatus).toBe('error');
  });

  it('replaces a same-day live snapshot whose fetchedAt is implausibly in the future', async () => {
    const now = new Date(`${TODAY}T12:00:00.000Z`);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    });

    const { useBankStore } = await import('./bankStore');
    const current = useBankStore.getState();
    const futureFetchedAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    useBankStore.setState({
      exchangeRates: {
        ...current.exchangeRates,
        source: 'frankfurter',
        asOf: TODAY,
        fetchedAt: futureFetchedAt,
      },
    });

    await expect(useBankStore.getState().refreshRates(true)).resolves.toBe('updated');
    expect(useBankStore.getState().exchangeRates.fetchedAt).toBe(now.toISOString());
    expect(useBankStore.getState().exchangeRates.fetchedAt).not.toBe(futureFetchedAt);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('replaces a newer-dated live snapshot whose fetchedAt is implausibly in the future', async () => {
    const now = new Date(`${TODAY}T12:00:00.000Z`);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    });

    const { useBankStore } = await import('./bankStore');
    const current = useBankStore.getState();
    const futureFetchedAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const newerAsOf = futureFetchedAt.slice(0, 10);
    expect(newerAsOf > TODAY).toBe(true);
    useBankStore.setState({
      exchangeRates: {
        ...current.exchangeRates,
        source: 'frankfurter',
        asOf: newerAsOf,
        fetchedAt: futureFetchedAt,
      },
    });

    await expect(useBankStore.getState().refreshRates(true)).resolves.toBe('updated');
    expect(useBankStore.getState().exchangeRates.asOf).toBe(TODAY);
    expect(useBankStore.getState().exchangeRates.fetchedAt).toBe(now.toISOString());
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('serializes first-run bootstrap so concurrent tabs adopt one seed', async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    let releaseGate: (() => void) | undefined;
    let lockTail: Promise<unknown> = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const requestLock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
      const result = lockTail.then(() => callback());
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    vi.setSystemTime('2026-09-01T12:00:00.000Z');
    const firstStore = (await import('./bankStore')).useBankStore;
    vi.setSystemTime('2026-09-02T12:00:00.000Z');
    vi.resetModules();
    const secondStore = (await import('./bankStore')).useBankStore;

    releaseGate?.();
    await lockTail;

    const persisted = JSON.parse(storage.get('cometa.bank') ?? '') as { state: BankState };
    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(firstStore.getState().transactions).toEqual(persisted.state.transactions);
    expect(secondStore.getState().transactions).toEqual(persisted.state.transactions);
  });

  it('derives fresh rates status when delayed module bootstrap adopts newer persistence', async () => {
    const nowISO = '2026-09-02T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    const initial = buildSeed(nowISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    let releaseGate: (() => void) | undefined;
    let lockTail: Promise<unknown> = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const requestLock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
      const result = lockTail.then(() => callback());
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    const { useBankStore } = await import('./bankStore');
    useBankStore.setState({ ratesStatus: 'error' });
    const newerPersisted = withFreshRates(initial, nowISO);
    storage.set(
      'cometa.bank',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: newerPersisted }),
    );

    releaseGate?.();
    await lockTail;

    expect(requestLock).toHaveBeenCalledOnce();
    expect(useBankStore.getState().exchangeRates).toEqual(newerPersisted.exchangeRates);
    expect(useBankStore.getState().ratesStatus).toBe('fresh');
  });

  it('keeps dirty in-memory state when delayed bootstrap falls back without entering its lock', async () => {
    const initial = buildSeed('2026-09-02T12:00:00.000Z');
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: initial })],
    ]);
    const setItem = vi.fn(() => {
      throw new DOMException('quota reached', 'QuotaExceededError');
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem,
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    let rejectBootstrap: ((reason: Error) => void) | undefined;
    const bootstrapAcquisition = new Promise<never>((_resolve, reject) => {
      rejectBootstrap = reject;
    });
    let lockCalls = 0;
    const requestLock = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new TypeError('Lock callback is missing');
      lockCalls += 1;
      return lockCalls === 1 ? bootstrapAcquisition : Promise.resolve(callback());
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { useBankStore } = await import('./bankStore');
    await useBankStore.getState().setPrimaryCurrency('GEL');
    expect(useBankStore.getState().primaryCurrency).toBe('GEL');
    expect(setItem).toHaveBeenCalledOnce();

    rejectBootstrap?.(new Error('bootstrap lock rejected'));
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledOnce());

    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(useBankStore.getState().primaryCurrency).toBe('GEL');
    warnSpy.mockRestore();
  });
});
