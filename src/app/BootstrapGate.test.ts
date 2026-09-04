import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from '@/platform/types';
import { startTelegramPreferenceBootstrap } from './BootstrapGate';

function telegramPlatform(): PlatformAdapter {
  return {
    isTelegram: true,
    getCurrentUser: () => ({ displayName: 'Ada', source: 'host' }),
    loadLaunchPreferences: async () => null,
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
