// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankImportRequest, BankImportResponse, LaunchState, PlatformAdapter } from '@/platform/types';
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
  importBank: vi.fn<PlatformAdapter['importBankState']>(),
}));

vi.mock('@/platform/environment', () => ({ isTelegramMiniApp: () => true }));
vi.mock('@/platform/usePlatform', () => {
  const platform: PlatformAdapter = {
    isTelegram: true,
    getSessionFingerprint: () => host.fingerprint,
    getCurrentUser: () => ({ telegramId: host.telegramId, displayName: 'Ada', source: 'host' }),
    loadLaunchState: (signal) => host.load(signal),
    importBankState: (request, signal) => host.importBank(request, signal),
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
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
    host.importBank.mockReset().mockRejectedValue(new Error('Unexpected server import in local bridge test'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'addEventListener');
    vi.spyOn(document, 'removeEventListener');
    vi.spyOn(globalThis, 'addEventListener');
    vi.spyOn(globalThis, 'removeEventListener');
    // Reference rates are unrelated to this lifecycle boundary; no real
    // provider requests are sent while the actual bank store is exercised.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Offline reference rates'); }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(App)));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(useBankStore.getState().profile.telegramId).toBe('42');
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  async function foreground(elapsedMs = 30_000): Promise<void> {
    // Move the budget clock without also firing unrelated future retry timers.
    vi.setSystemTime(Date.now() + elapsedMs);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  }

  async function scheduledRetry(): Promise<void> {
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
  }

  it.each(['success', 'failure', 'timeout'] as const)(
    'shows progress without a retry button during first import, then handles %s', async outcome => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const persisted = storage.get('cometa.bank.tma.user.42');
      const transactions = useBankStore.getState().transactions;
      let request: BankImportRequest | undefined;
      let importSignal: AbortSignal | undefined;
      let resolve!: (value: BankImportResponse) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<BankImportResponse>((done, fail) => { resolve = done; reject = fail; });
      host.importBank.mockImplementationOnce((value, signal) => {
        request = value;
        importSignal = signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        return pending;
      });
      host.load.mockResolvedValue({
        ...preferences(),
        bank: { contractVersion: 1, mode: 'import_required', telegramId: '42' },
      });
      await foreground();
      expect(host.importBank).toHaveBeenCalledOnce();
      expect(useBankStore.getState().ledgerMode).toBe('read_only');
      expect(container.textContent).toContain('Setting up Cometa');
      expect(container.textContent).not.toContain('could not sync');
      expect(container.querySelector('button')).toBeNull();
      expect(importSignal?.aborted).toBe(false);
      expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
      if (outcome === 'success') {
        if (request === undefined) throw new Error('Expected the import snapshot');
        const response: BankImportResponse = {
          version: 1, mode: 'server', imported: true, telegramId: '42',
          revisionEpoch: 'b'.repeat(32), revision: 1, digest: 'c'.repeat(64),
          warnings: [], state: request.state,
        };
        await act(async () => resolve(response));
        expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
        expect(useBankStore.getState().ledgerMode).toBe('server');
      } else {
        if (outcome === 'failure') await act(async () => reject(new TypeError('Import connection failed')));
        else await act(async () => vi.advanceTimersByTimeAsync(4_500));
        expect(container.textContent).toContain('Cometa could not sync safely');
        expect(container.querySelector('button')?.textContent).toBe('Try again');
        expect(useBankStore.getState().ledgerMode).toBe('read_only');
        expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
        const retryButton = container.querySelector('button');
        retryButton?.focus();
        const retry = pendingBootstrap();
        let retryRequest: BankImportRequest | undefined;
        let retryImportSignal: AbortSignal | undefined;
        let finishRetryImport!: (value: BankImportResponse) => void;
        host.importBank.mockImplementationOnce((value, signal) => {
          retryRequest = value;
          retryImportSignal = signal;
          return new Promise<BankImportResponse>(resolve => { finishRetryImport = resolve; });
        });
        await scheduledRetry();
        expect(container.querySelector('button')).toBe(retryButton);
        expect(retryButton?.getAttribute('aria-disabled')).toBe('true');
        expect(document.activeElement).toBe(retryButton);
        expect(container.querySelector('[role="status"]')?.textContent).toContain('Syncing with Cometa');
        expect(container.textContent).not.toContain('could not sync');
        expect(container.textContent).not.toContain('Nothing will change');
        expect(container.textContent).not.toContain('Setting up Cometa');
        const loadCount = host.load.mock.calls.length;
        await act(async () => retryButton?.click());
        expect(host.load).toHaveBeenCalledTimes(loadCount);
        expect(retry.signal().aborted).toBe(false);
        await act(async () => retry.resolve({
          ...preferences(),
          bank: { contractVersion: 1, mode: 'import_required', telegramId: '42' },
        }));
        expect(host.importBank).toHaveBeenCalledTimes(2);
        expect(container.querySelector('button')).toBe(retryButton);
        expect(document.activeElement).toBe(retryButton);
        expect(container.querySelector('[role="status"]')?.textContent).toContain('Syncing with Cometa');
        expect(container.textContent).not.toContain('Nothing will change');
        expect(retryImportSignal?.aborted).toBe(false);
        expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
        if (retryRequest === undefined) throw new Error('Expected the retry import snapshot');
        const importedState = retryRequest.state;
        await act(async () => finishRetryImport({
          version: 1, mode: 'server', imported: true, telegramId: '42',
          revisionEpoch: 'b'.repeat(32), revision: 1, digest: 'c'.repeat(64),
          warnings: [], state: importedState,
        }));
        expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
        expect(useBankStore.getState().ledgerMode).toBe('server');
      }
      expect(useBankStore.getState().transactions).toEqual(transactions);
    },
  );

  it('coalesces foreground churn during an unfinished cold bootstrap into one request', async () => {
    await act(async () => root?.unmount());
    host.load.mockClear();
    const pending = pendingBootstrap();
    root = createRoot(container);
    await act(async () => root?.render(createElement(App)));
    expect(host.load).toHaveBeenCalledOnce();
    for (let edge = 0; edge < 5; edge += 1) await foreground(0);
    expect(host.load).toHaveBeenCalledOnce();
    expect(pending.signal().aborted).toBe(false);
    await act(async () => pending.resolve(preferences()));
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
  });

  it('retains the server-copy decision and local history through same-session offline foreground', async () => {
    const persisted = storage.get('cometa.bank.tma.user.42');
    const local = JSON.parse(persisted ?? '{}').state as ReturnType<typeof buildSeed>;
    const server: LaunchState = {
      ...preferences(),
      bank: {
        contractVersion: 1, mode: 'server', telegramId: '42',
        revisionEpoch: 'b'.repeat(32), revision: 1, digest: 'c'.repeat(64),
        warnings: [], state: { ...local, primaryCurrency: 'USD' },
      },
    };
    host.load.mockResolvedValue(server);
    await foreground();
    expect(useBankStore.getState().ledgerSyncError).toBe('server_copy_confirmation_required');
    expect(container.textContent).toContain('Use server copy');
    const failed = pendingBootstrap();
    await scheduledRetry();
    expect(container.textContent).toContain('Use server copy');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => failed.reject(new TypeError('Offline while choosing a server copy')));
    expect(container.textContent).toContain('Use server copy');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    const button = container.querySelector('button');
    if (button === null) throw new Error('Server-copy confirmation is missing');
    await act(async () => button.click());
    expect(useBankStore.getState().ledgerMode).toBe('server');
    expect(useBankStore.getState().primaryCurrency).toBe('USD');
  });

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
    await scheduledRetry();
    await act(async () => retry.resolve(preferences()));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('output')?.textContent).toContain('123');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
  });

  it('finishes a verified local-mode foreground sync without unmounting the bank shell', async () => {
    const persisted = storage.get('cometa.bank.tma.user.42');
    const rateRequests = vi.mocked(fetch).mock.calls.length;
    const pending = pendingBootstrap();
    await foreground();

    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(pending.signal().aborted).toBe(false);
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    expect(fetch).toHaveBeenCalledTimes(rateRequests);

    await act(async () => pending.resolve(preferences()));
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    expect(fetch).toHaveBeenCalledTimes(rateRequests + 1);
  });

  it('coalesces persisted pageshow and visibility refreshes after readiness', async () => {
    const previousCount = host.load.mock.calls.length;
    const pending = pendingBootstrap();
    vi.setSystemTime(Date.now() + 30_000);
    await act(async () => {
      globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      document.dispatchEvent(new Event('visibilitychange'));
      globalThis.dispatchEvent(new Event('online'));
    });
    expect(host.load).toHaveBeenCalledTimes(previousCount + 1);
    expect(pending.signal().aborted).toBe(false);
    await act(async () => pending.resolve(preferences()));
    expect(container.querySelector('main h1')?.textContent).toBe('Cometa');
  });

  it('quarantines a changed raw identity immediately while its HTTP retry waits for cooldown', async () => {
    const previousUser = storage.get('cometa.bank.tma.user.42');
    const previousCount = host.load.mock.calls.length;
    const pending = pendingBootstrap();
    host.fingerprint = 'changed-during-cooldown';
    await foreground(0);
    expect(useBankStore.getState().profile.telegramId).toBeUndefined();
    expect(container.querySelector('main')).toBeNull();
    expect(host.load).toHaveBeenCalledTimes(previousCount);
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(host.load).toHaveBeenCalledTimes(previousCount);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.load).toHaveBeenCalledTimes(previousCount + 1);
    expect(pending.signal().aborted).toBe(false);
    await act(async () => pending.resolve(preferences('43')));
    expect(container.querySelector('main')?.textContent).toContain('Grace');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(previousUser);
  });

  it('aborts an obsolete in-flight identity without starting an unmetered replacement', async () => {
    const previousUser = storage.get('cometa.bank.tma.user.42');
    const stale = pendingBootstrap();
    await foreground();
    const previousCount = host.load.mock.calls.length;
    host.fingerprint = 'changed-with-request-in-flight';
    await foreground(0);
    expect(stale.signal().aborted).toBe(true);
    expect(useBankStore.getState().profile.telegramId).toBeUndefined();
    expect(container.querySelector('main')).toBeNull();
    expect(host.load).toHaveBeenCalledTimes(previousCount);
    const current = pendingBootstrap();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(host.load).toHaveBeenCalledTimes(previousCount + 1);
    await act(async () => current.resolve(preferences('43')));
    expect(container.querySelector('main')?.textContent).toContain('Grace');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(previousUser);
  });

  it('retries a failed verified local foreground bootstrap without changing the bank state', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const persisted = storage.get('cometa.bank.tma.user.42');
    const failed = pendingBootstrap();
    await foreground();
    await act(async () => failed.reject(new TypeError('Connection interrupted')));

    expect(warnings).toHaveBeenCalledWith('[telegram] preferences bootstrap failed: Connection interrupted');
    expect(useBankStore.getState().ledgerMode).toBe('local');
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    const retry = pendingBootstrap();
    await scheduledRetry();
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
    const persisted = storage.get('cometa.bank.tma.user.42');
    await foreground();
    await act(async () => {
      globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      globalThis.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(host.load).toHaveBeenCalledTimes(countAfterUnmount);
    expect(storage.get('cometa.bank.tma.user.42')).toBe(persisted);
    const visibilityListeners = vi.mocked(document.addEventListener).mock.calls
      .filter(([name]) => name === 'visibilitychange');
    expect(visibilityListeners).toHaveLength(1);
    for (const [name, listener] of visibilityListeners) {
      expect(document.removeEventListener).toHaveBeenCalledWith(name, listener);
    }
    const recoveryListeners = vi.mocked(globalThis.addEventListener).mock.calls
      .filter(([name]) => name === 'pageshow' || name === 'online');
    expect(recoveryListeners).toHaveLength(2);
    for (const [name, listener] of recoveryListeners) {
      expect(globalThis.removeEventListener).toHaveBeenCalledWith(name, listener);
    }
  });
});
