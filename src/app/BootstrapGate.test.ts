import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from '@/platform/types';
import { startTelegramPreferenceBootstrap } from './BootstrapGate';

function telegramPlatform(): PlatformAdapter {
  return {
    isTelegram: true,
    getCurrentUser: () => ({ displayName: 'Ada', source: 'host' }),
    loadLaunchState: async () => null,
    importBankState: async () => {
      throw new Error('unexpected import');
    },
    executeBankCommand: async () => {
      throw new Error('unexpected command');
    },
    refreshBankRates: async () => {
      throw new Error('unexpected rate refresh');
    },
    haptic() {},
    copyText: async () => false,
    mainButton: { supported: false, show() {}, hide() {} },
    armBack: () => () => undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startTelegramPreferenceBootstrap', () => {
  it('recovers late first SDK data on the bounded cold ladder without any external event', async () => {
    vi.useFakeTimers();
    let fingerprint: string | undefined = undefined;
    const synchronize = vi.fn(async () => fingerprint === undefined ? 'absent' as const : 'applied' as const);
    const onReady = vi.fn();
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady, synchronize, subscribeRetry: () => () => undefined,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(synchronize).toHaveBeenCalledOnce();
    fingerprint = 'late-without-an-edge';
    await vi.advanceTimersByTimeAsync(700);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
    cleanup();
  });

  it('bounds repeated cold absence without extending the splash past its deadline', async () => {
    vi.useFakeTimers();
    const synchronize = vi.fn().mockResolvedValue('absent');
    const onReady = vi.fn();
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => undefined },
      onReady, synchronize, subscribeRetry: () => () => undefined,
    });
    await vi.advanceTimersByTimeAsync(4_499);
    expect(onReady).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('adopts the first late fingerprint without aborting cold bootstrap or imposing foreground cooldown', async () => {
    vi.useFakeTimers();
    let fingerprint: string | undefined = undefined;
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    let resolveFirst: ((result: 'retry') => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const onReady = vi.fn();
    const synchronize = vi.fn()
      .mockImplementationOnce((_platform: PlatformAdapter, signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise<'retry'>(resolve => { resolveFirst = resolve; });
      })
      .mockResolvedValueOnce('applied');
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady, synchronize,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(100);
    fingerprint = 'first-available-session';
    retryOnSignal?.('visible');
    expect(firstSignal?.aborted).toBe(false);
    resolveFirst?.('retry');
    await vi.advanceTimersByTimeAsync(999);
    expect(synchronize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
    cleanup();
  });

  it('does not retry a terminal cold failure when the first SDK fingerprint appeared mid-attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fingerprint: string | undefined = undefined;
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    let rejectFirst: ((error: Error) => void) | undefined;
    const pending = vi.fn();
    const synchronize = vi.fn()
      .mockImplementationOnce(() => new Promise<'applied'>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue('applied');
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, onPendingChange: pending, synchronize,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(100);
    fingerprint = 'first-session-visible-to-in-flight-request';
    rejectFirst?.(Object.assign(new Error('unsupported contract'), { retryable: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.mock.calls).toEqual([[true], [false]]);
    retryOnSignal?.('visible');
    retryOnSignal?.('online');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(pending.mock.calls).toEqual([[true], [false]]);
    fingerprint = 'new-session-after-terminal-failure';
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(pending.mock.calls).toEqual([[true], [false], [true], [false]]);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops foreground retries after a terminal error following success but allows a new identity', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fingerprint = 'verified-first-session';
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValueOnce('current')
      .mockRejectedValueOnce(Object.assign(new Error('unsupported contract'), { retryable: false }))
      .mockResolvedValue('applied');
    const pending = vi.fn();
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, onPendingChange: pending, synchronize, externalRetryCooldownMs: 10,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(10);
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(pending.mock.calls).toEqual([[true], [false], [true], [false]]);
    for (let edge = 0; edge < 5; edge += 1) {
      await vi.advanceTimersByTimeAsync(10);
      retryOnSignal?.('online');
      retryOnSignal?.('visible');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(synchronize).toHaveBeenCalledTimes(2);
    fingerprint = 'verified-next-session';
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it('retries a completed absent cold launch on the short ladder when its first fingerprint appears', async () => {
    vi.useFakeTimers();
    let fingerprint: string | undefined = undefined;
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValueOnce('absent').mockResolvedValue('applied');
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, synchronize,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(100);
    fingerprint = 'first-available-after-null';
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it.each([
    { label: 'after the cold ladder is exhausted', availableAt: 15_000, earlierEdgeAt: undefined, starts: [0, 1_000, 4_000, 12_000, 16_000] },
    { label: 'while a cold ladder timer is pending', availableAt: 5_000, earlierEdgeAt: undefined, starts: [0, 1_000, 4_000, 6_000] },
    { label: 'while an external cooldown timer is pending', availableAt: 15_000, earlierEdgeAt: 14_000, starts: [0, 1_000, 4_000, 12_000, 16_000] },
  ])('resumes first SDK availability in one second $label without leaving duplicate timers', async ({ availableAt, earlierEdgeAt, starts }) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const actualStarts: number[] = [];
    let fingerprint: string | undefined = undefined;
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn(async () => {
      actualStarts.push(Date.now() - startedAt);
      return fingerprint === undefined ? 'absent' as const : 'applied' as const;
    });
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, synchronize,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    if (earlierEdgeAt !== undefined) {
      await vi.advanceTimersByTimeAsync(earlierEdgeAt);
      retryOnSignal?.('online');
      expect(vi.getTimerCount()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(availableAt - (earlierEdgeAt ?? 0));
    fingerprint = 'first-available-after-cold-absence';
    for (let edge = 0; edge < 5; edge += 1) retryOnSignal?.('visible');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(actualStarts).toEqual(starts.slice(0, -1));
    await vi.advanceTimersByTimeAsync(1);
    expect(actualStarts).toEqual(starts);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actualStarts).toEqual(starts);
    cleanup();
  });

  it('does not reset the global attempt budget when first SDK data finally appears', async () => {
    vi.useFakeTimers();
    let fingerprint: string | undefined = undefined;
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn(async () => fingerprint === undefined ? 'absent' as const : 'applied' as const);
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, synchronize, maxAttempts: 4,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(synchronize).toHaveBeenCalledTimes(4);
    fingerprint = 'first-available-at-budget-limit';
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('keeps cooldown when a previously observed session disappears and returns after an absent probe', async () => {
    vi.useFakeTimers();
    let fingerprint: string | undefined = 'original-session';
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValueOnce('current')
      .mockResolvedValueOnce('absent').mockResolvedValue('applied');
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, synchronize, externalRetryCooldownMs: 10, retryDelaysMs: [1],
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(0);
    fingerprint = undefined;
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronize).toHaveBeenCalledTimes(2);
    fingerprint = 'returning-session';
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(synchronize).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it('publishes pending for success timeout and identity cancellation but never after cleanup', async () => {
    vi.useFakeTimers();
    let fingerprint = 'first-session';
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    let resolveLast: ((result: 'applied') => void) | undefined;
    const pending = vi.fn();
    const synchronize = vi.fn().mockResolvedValueOnce('current')
      .mockImplementation(() => new Promise<'applied'>(resolve => { resolveLast = resolve; }));
    const cleanup = startTelegramPreferenceBootstrap({
      platform: { ...telegramPlatform(), getSessionFingerprint: () => fingerprint },
      onReady: () => undefined, onPendingChange: pending, synchronize,
      attemptTimeoutMs: 20, retryDelaysMs: [1], externalRetryCooldownMs: 10,
      subscribeRetry: listener => { retryOnSignal = listener; return () => undefined; },
    });
    expect(pending.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending.mock.calls).toEqual([[true], [false]]);
    retryOnSignal?.('visible');
    expect(pending.mock.calls).toEqual([[true], [false], [true]]);
    await vi.advanceTimersByTimeAsync(20);
    expect(pending.mock.calls).toEqual([[true], [false], [true], [false]]);
    await vi.advanceTimersByTimeAsync(1);
    fingerprint = 'next-session';
    retryOnSignal?.('visible');
    expect(pending.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
    cleanup();
    resolveLast?.('applied');
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveBeenCalledTimes(6);
  });

  it('does not publish pending after cleanup aborts an active attempt', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let resolve: ((result: 'applied') => void) | undefined;
    const pending = vi.fn();
    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(), onReady: () => undefined, onPendingChange: pending,
      synchronize: (_platform, attemptSignal) => {
        signal = attemptSignal;
        return new Promise<'applied'>(done => { resolve = done; });
      },
    });
    expect(pending.mock.calls).toEqual([[true]]);
    cleanup();
    expect(signal?.aborted).toBe(true);
    resolve?.('applied');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending.mock.calls).toEqual([[true]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('meters successful foreground refreshes under the same rolling budget as cold bootstrap', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onSynchronized = vi.fn();
    let signal: ((event: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValue('current');
    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(), onReady, onSynchronized, synchronize,
      maxAttempts: 3, attemptWindowMs: 100, externalRetryCooldownMs: 10,
      subscribeRetry: (listener) => { signal = listener; return () => undefined; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(onSynchronized).not.toHaveBeenCalled();
    for (let round = 0; round < 2; round += 1) {
      for (let edge = 0; edge < 20; edge += 1) signal?.('visible');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(onSynchronized).toHaveBeenCalledTimes(2);
    for (let edge = 0; edge < 20; edge += 1) signal?.('online');
    await vi.advanceTimersByTimeAsync(50);
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(31);
    signal?.('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(4);
    expect(onReady).toHaveBeenCalledOnce();
    cleanup();
  });

  it('recovers HTTP 502 before releasing the splash when the retry fits the deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onReady = vi.fn();
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Telegram preferences request failed (502)'), { retryable: true }),
      )
      .mockResolvedValueOnce('applied');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      retryDelaysMs: [1_000],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(synchronize).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(synchronize).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('bounds repeated background retries and retries an explicit persistence retry result', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const synchronize = vi.fn().mockResolvedValue('retry');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 100,
      retryDelaysMs: [10, 20],
    });
    await vi.advanceTimersByTimeAsync(30);

    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(70);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('queues one online recovery until the external retry cooldown expires', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onReady = vi.fn();
    const unsubscribe = vi.fn();
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('still offline'))
      .mockResolvedValueOnce('applied');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      retryDelaysMs: [10],
      externalRetryCooldownMs: 20,
      subscribeRetry: (listener) => {
        retryOnSignal = listener;
        return unsubscribe;
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    retryOnSignal?.('online');
    await vi.advanceTimersByTimeAsync(19);

    expect(synchronize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    retryOnSignal?.('online');
    expect(synchronize).toHaveBeenCalledTimes(3);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not drop an online edge received during the final in-flight attempt', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    let resolveFirst: ((result: 'retry') => void) | undefined;
    const synchronize = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<'retry'>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce('applied');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      retryDelaysMs: [],
      externalRetryCooldownMs: 10,
      subscribeRetry: (listener) => {
        retryOnSignal = listener;
        return () => undefined;
      },
    });
    retryOnSignal?.('online');
    retryOnSignal?.('visible');
    resolveFirst?.('retry');
    await vi.advanceTimersByTimeAsync(0);

    expect(synchronize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9);
    expect(synchronize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('caps attempts across visibility recovery ladders and coalesces visibility spam', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    let attempt = 0;
    const synchronize = vi.fn(async (): Promise<'applied' | 'retry'> => {
      attempt += 1;
      return attempt === 6 ? 'applied' : 'retry';
    });

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 1_000,
      retryDelaysMs: [1],
      maxAttempts: 5,
      attemptWindowMs: 100,
      externalRetryCooldownMs: 10,
      subscribeRetry: (listener) => {
        retryOnSignal = listener;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(synchronize).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 20; index += 1) retryOnSignal?.('visible');
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    expect(synchronize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(4);

    for (let index = 0; index < 20; index += 1) retryOnSignal?.('visible');
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(synchronize).toHaveBeenCalledTimes(5);

    for (let index = 0; index < 20; index += 1) retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(50);
    expect(synchronize).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(51);
    retryOnSignal?.('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(synchronize).toHaveBeenCalledTimes(6);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('limits a visibility burst to twelve attempts inside the default rolling budget', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValue('retry');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 1_000,
      retryDelaysMs: [],
      externalRetryCooldownMs: 1,
      subscribeRetry: (listener) => {
        retryOnSignal = listener;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 1; attempt < 12; attempt += 1) {
      retryOnSignal?.('visible');
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(synchronize).toHaveBeenCalledTimes(12);

    retryOnSignal?.('online');
    retryOnSignal?.('visible');
    await vi.advanceTimersByTimeAsync(100);
    expect(synchronize).toHaveBeenCalledTimes(12);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a queued external recovery timer when the gate unmounts', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const unsubscribe = vi.fn();
    let retryOnSignal: ((signal: 'online' | 'visible') => void) | undefined;
    const synchronize = vi.fn().mockResolvedValue('retry');

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      retryDelaysMs: [],
      externalRetryCooldownMs: 30,
      subscribeRetry: (listener) => {
        retryOnSignal = listener;
        return unsubscribe;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    retryOnSignal?.('online');
    expect(vi.getTimerCount()).toBe(2);

    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not retry an explicitly permanent bootstrap failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onReady = vi.fn();
    const permanentError = Object.assign(new Error('unauthorized'), { retryable: false });
    const synchronize = vi.fn(
      (
        _platform: PlatformAdapter,
        _signal: AbortSignal,
        _target?: unknown,
        onIdentityIsolated?: VoidFunction,
      ) => {
        onIdentityIsolated?.();
        return Promise.reject(permanentError);
      },
    );

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      retryDelaysMs: [10, 20],
    });
    await vi.runAllTimersAsync();

    expect(synchronize).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('releases the splash at the hard deadline after identity isolation then recovers', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const observedSignals: AbortSignal[] = [];
    const synchronize = vi
      .fn()
      .mockImplementationOnce(
        (
          _platform: PlatformAdapter,
          signal: AbortSignal,
          _target?: unknown,
          onIdentityIsolated?: VoidFunction,
        ) => {
          observedSignals.push(signal);
          onIdentityIsolated?.();
          return new Promise<'absent'>(() => undefined);
        },
      )
      .mockImplementationOnce(async (_platform: PlatformAdapter, signal: AbortSignal) => {
        observedSignals.push(signal);
        return 'applied';
      });

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 50,
      attemptTimeoutMs: 60,
      retryDelaysMs: [10],
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(observedSignals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(observedSignals[1]?.aborted).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });

  it('keeps the splash past its deadline until identity isolation is confirmed', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    let markIdentityIsolated: VoidFunction | undefined;
    const synchronize = vi.fn(
      (
        _platform: PlatformAdapter,
        _signal: AbortSignal,
        _target?: unknown,
        onIdentityIsolated?: VoidFunction,
      ) => {
        markIdentityIsolated = onIdentityIsolated;
        return new Promise<'absent'>(() => undefined);
      },
    );

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 50,
      attemptTimeoutMs: 100,
      retryDelaysMs: [],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(onReady).not.toHaveBeenCalled();

    markIdentityIsolated?.();
    expect(onReady).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledOnce();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a stale fulfilled attempt until the current attempt isolates identity', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    let attempt = 0;
    let resolveStale: ((result: 'applied') => void) | undefined;
    let isolateCurrent: VoidFunction | undefined;
    const synchronize = vi.fn(
      (
        _platform: PlatformAdapter,
        _signal: AbortSignal,
        _target?: unknown,
        onIdentityIsolated?: VoidFunction,
      ) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<'applied'>((resolve) => {
            resolveStale = resolve;
          });
        }
        isolateCurrent = onIdentityIsolated;
        return new Promise<'applied'>(() => undefined);
      },
    );

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
      timeoutMs: 5,
      attemptTimeoutMs: 10,
      retryDelaysMs: [1],
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(onReady).not.toHaveBeenCalled();

    resolveStale?.('applied');
    await vi.advanceTimersByTimeAsync(0);
    expect(onReady).not.toHaveBeenCalled();

    isolateCurrent?.();
    expect(onReady).toHaveBeenCalledOnce();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts on cleanup without releasing an unmounted gate', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const onReady = vi.fn();
    const synchronize = vi.fn((_platform: PlatformAdapter, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<'absent'>(() => undefined);
    });

    const cleanup = startTelegramPreferenceBootstrap({
      platform: telegramPlatform(),
      onReady,
      synchronize,
    });
    cleanup();
    await Promise.resolve();

    expect(observedSignal?.aborted).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
