// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchState, PlatformAdapter } from '@/platform/types';
import { markStickyServerLedgerMode } from '@/platform/ledgerAuthorityReceipt';
import { buildSeed } from '@/domain/seed';
import { useBankStore } from '@/store/bankStore';
import { quarantineTelegramPersistence } from '@/store/persistence';
import { useUiStore } from '@/store/uiStore';
import { App } from './App';

const host = vi.hoisted(() => ({
  fingerprint: 'initial-session',
  telegramId: '42',
  load: vi.fn<(signal?: AbortSignal) => Promise<LaunchState | null>>(),
}));

vi.mock('@/platform/environment', () => ({ isTelegramMiniApp: () => true }));
vi.mock('@/platform/usePlatform', () => {
  const platform: PlatformAdapter = {
    isTelegram: true,
    getSessionFingerprint: () => host.fingerprint,
    getCurrentUser: () => ({ telegramId: host.telegramId, displayName: 'Ada', source: 'host' }),
    loadLaunchState: (signal) => host.load(signal),
    importBankState: async () => { throw new Error('Unexpected server import in local bridge test'); },
    executeBankCommand: async () => { throw new Error('Unexpected server command in local bridge test'); },
    refreshBankRates: async () => { throw new Error('Unexpected server rates in local bridge test'); },
    haptic: () => undefined,
    copyText: async () => false,
    mainButton: { supported: false, show: () => undefined, hide: () => undefined },
    armBack: () => () => undefined,
  };
  return {
    usePlatform: () => platform,
    PlatformProvider: ({ children }: { children: ReactNode }) => children,
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const preferences = (telegramId = '42', revision = 1): LaunchState => ({
  version: 1, telegramId, revision,
  revisionEpoch: '0123456789abcdef0123456789abcdef',
  locale: 'en', primaryCurrency: 'KZT', displayName: telegramId === '42' ? 'Ada' : 'Grace',
});

describe('Telegram foreground synchronization ownership', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  let attempt = 0;
  const storage = new Map<string, string>();

  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    quarantineTelegramPersistence();
    useBankStore.setState({ ...buildSeed(new Date().toISOString()), ledgerMode: 'read_only', ledgerSyncError: null });
    useUiStore.getState().resetUi();
    useUiStore.setState({ locale: 'en' });
    host.fingerprint = `launch-${++attempt}`;
    host.telegramId = '42';
    host.load.mockReset().mockResolvedValue(preferences());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    // Reference rates are unrelated to this lifecycle boundary; no real
    // provider requests are sent while the actual bank store is exercised.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Offline reference rates'); }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(App)));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('main h1')?.textContent).toBe('Cometa'));
    });
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(useBankStore.getState().profile.telegramId).toBe('42');
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function pendingBootstrap(): {
    readonly signal: () => AbortSignal;
    readonly resolve: (state: LaunchState) => void;
    readonly reject: (error: Error) => void;
  } {
    let capturedSignal: AbortSignal | undefined;
    let resolve!: (state: LaunchState) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<LaunchState>((done, fail) => { resolve = done; reject = fail; });
    host.load.mockImplementationOnce((signal) => {
      capturedSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      return promise;
    });
    return {
      signal: () => {
        if (capturedSignal === undefined) throw new Error('Foreground bootstrap was not started');
        return capturedSignal;
      },
      resolve, reject,
    };
  }

  async function foreground(): Promise<void> {
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  }

  it('preserves an unsent transfer draft through same-identity local foreground success, failure and retry', async () => {
    await act(async () => useUiStore.getState().openSheet({ kind: 'transferOwn' }));
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error('Transfer dialog is missing');
    for (const digit of ['1', '2', '3']) {
      const key = dialog.querySelector<HTMLButtonElement>(`button[aria-label="${digit}"]`);
      if (key === null) throw new Error(`Transfer keypad ${digit} is missing`);
      await act(async () => key.click());
    }
    expect(dialog.querySelector('output')?.textContent).toContain('123');
    const pending = pendingBootstrap();
    await foreground();

    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('output')?.textContent).toContain('123');
    expect(pending.signal().aborted).toBe(false);
    await act(async () => pending.resolve(preferences()));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('output')?.textContent).toContain('123');

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const persisted = storage.get('cometa.bank.tma.user.42');
    const failed = pendingBootstrap();
    await foreground();
    await act(async () => failed.reject(new TypeError('Connection interrupted')));
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('output')?.textContent).toContain('123');
    const retry = pendingBootstrap();
    await foreground();
    await act(async () => retry.resolve(preferences()));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('output')?.textContent).toContain('123');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
  });

  it('finishes a verified local-mode foreground sync without unmounting the bank shell', async () => {
    const persisted = storage.get('cometa.bank.tma.user.42');
    const pending = pendingBootstrap();
    await foreground();

    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(pending.signal().aborted).toBe(false);
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);

    await act(async () => pending.resolve(preferences()));
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
  });

  it('retries a failed verified local foreground bootstrap without changing the bank state', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const persisted = storage.get('cometa.bank.tma.user.42');
    const failed = pendingBootstrap();
    await foreground();
    await act(async () => failed.reject(new TypeError('Connection interrupted')));

    expect(warnings).toHaveBeenCalledWith('[telegram] foreground bank sync failed: Connection interrupted');
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    const retry = pendingBootstrap();
    await foreground();
    expect(retry.signal().aborted).toBe(false);
    await act(async () => retry.resolve(preferences()));

    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
  });

  it('quarantines a formerly local session when a sticky server marker appears and refuses local fallback', async () => {
    const persisted = storage.get('cometa.bank.tma.user.42');
    expect(markStickyServerLedgerMode('42')).toBe(true);
    const pending = pendingBootstrap();
    await foreground();

    expect(useBankStore.getState().ledgerMode).toBe('read_only');
    expect(useBankStore.getState().ledgerSyncError).toBe('server_sync_required');
    expect(container.querySelector('main')).toBeNull();
    expect(pending.signal().aborted).toBe(false);
    await act(async () => pending.resolve(preferences()));

    expect(useBankStore.getState().ledgerMode).toBe('read_only');
    expect(useBankStore.getState().ledgerSyncError).toBe('server_api_unavailable');
    expect(container.querySelector('main')).toBeNull();
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
  });

  it('finishes a new-identity foreground bootstrap without exposing or overwriting the previous user', async () => {
    const previousUser = storage.get('cometa.bank.tma.user.42');
    host.fingerprint = 'new-raw-session-for-grace';
    // Parsed SDK identity intentionally trails the new raw launch fingerprint.
    expect(host.telegramId).toBe('42');
    const pending = pendingBootstrap();
    await foreground();

    expect(useBankStore.getState().ledgerMode).toBe('read_only');
    expect(useBankStore.getState().profile.telegramId).toBeUndefined();
    expect(container.querySelector('main')).toBeNull();
    expect(pending.signal().aborted).toBe(false);
    expect(storage.get('cometa.bank.tma.user.43')).toBeUndefined();
    await act(async () => pending.resolve(preferences('43')));

    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(useBankStore.getState().profile).toEqual({ telegramId: '43', displayName: 'Grace' });
    expect(container.querySelector('main')?.textContent).toContain('Grace');
    expect(container.querySelector('main')?.textContent).not.toContain('Ada');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(previousUser);
    expect(JSON.parse(storage.get('cometa.bank.tma.user.43') ?? '{}')).toMatchObject({
      state: { profile: { telegramId: '43', displayName: 'Grace' } },
    });
  });

  it('aborts an in-flight foreground request only when the owning application unmounts', async () => {
    const pending = pendingBootstrap();
    await foreground();
    expect(pending.signal().aborted).toBe(false);

    await act(async () => root?.unmount());
    root = undefined;
    expect(pending.signal().aborted).toBe(true);
    const countAfterUnmount = host.load.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(host.load).toHaveBeenCalledTimes(countAfterUnmount);
  });
});
