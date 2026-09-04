import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PlatformAdapter } from './types';
import { webAdapter } from './adapter.web';
import {
  createTelegramAdapter,
  initializeTelegram,
  isTelegramSetupComplete,
} from './adapter.telegram';
import { isTelegramMiniApp } from './environment';

interface PlatformContextValue {
  adapter: PlatformAdapter;
  readinessEpoch: number;
}

const PlatformContext = createContext<PlatformContextValue>({
  adapter: webAdapter,
  readinessEpoch: 0,
});
const telegramRuntime = isTelegramMiniApp();
const runtimeAdapter = telegramRuntime ? createTelegramAdapter() : webAdapter;
const TELEGRAM_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;

interface TelegramRetryLoopOptions {
  initialize(): void;
  isComplete(): boolean;
  getVisibility(): DocumentVisibilityState;
  subscribeVisibility(listener: VoidFunction): VoidFunction;
  onAttempt(): void;
}

export function startTelegramRetryLoop(options: TelegramRetryLoopOptions): VoidFunction {
  let cancelled = false;
  let retryIndex = 0;
  let retryId: ReturnType<typeof globalThis.setTimeout> | undefined;

  const attempt = () => {
    retryId = undefined;
    if (cancelled) return;
    options.initialize();
    options.onAttempt();
    if (options.isComplete() || retryIndex >= TELEGRAM_RETRY_DELAYS_MS.length) return;
    retryId = globalThis.setTimeout(attempt, TELEGRAM_RETRY_DELAYS_MS[retryIndex++]);
  };

  attempt();
  const retryWhenVisible = () => {
    if (options.getVisibility() !== 'visible' || options.isComplete()) return;
    if (retryId !== undefined) globalThis.clearTimeout(retryId);
    retryIndex = 0;
    attempt();
  };
  const unsubscribe = options.subscribeVisibility(retryWhenVisible);

  return () => {
    cancelled = true;
    if (retryId !== undefined) globalThis.clearTimeout(retryId);
    unsubscribe();
  };
}

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [readinessEpoch, setReadinessEpoch] = useState(0);

  useEffect(() => {
    if (!telegramRuntime) return;
    return startTelegramRetryLoop({
      initialize: initializeTelegram,
      isComplete: isTelegramSetupComplete,
      getVisibility: () => document.visibilityState,
      subscribeVisibility: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      onAttempt: () => setReadinessEpoch((epoch) => epoch + 1),
    });
  }, []);

  const contextValue = useMemo(
    () => ({ adapter: runtimeAdapter, readinessEpoch }),
    [readinessEpoch],
  );
  return <PlatformContext.Provider value={contextValue}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformAdapter {
  return useContext(PlatformContext).adapter;
}
