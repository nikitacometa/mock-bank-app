import { useEffect, useState, type ReactNode } from 'react';
import { translate } from '@/i18n/catalog';
import { usePlatform } from '@/platform/usePlatform';
import type { PlatformAdapter } from '@/platform/types';
import { useUiStore } from '@/store/uiStore';
import { CometMark } from '@/ui/icons';
import { APP_NAME } from './config';
import { synchronizeLaunchPreferences } from './launchPreferences';

const BOOTSTRAP_TIMEOUT_MS = 4_500;
const BOOTSTRAP_ATTEMPT_TIMEOUT_MS = 4_500;
const BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
const BOOTSTRAP_MAX_ATTEMPTS = 12;
const BOOTSTRAP_ATTEMPT_WINDOW_MS = 5 * 60_000;
const BOOTSTRAP_EXTERNAL_RETRY_COOLDOWN_MS = 30_000;

type TelegramBootstrapRetrySignal = 'online' | 'visible';
type TelegramBootstrapRetryListener = (signal: TelegramBootstrapRetrySignal) => void;

interface TelegramBootstrapOptions {
  readonly platform: PlatformAdapter;
  readonly onReady: VoidFunction;
  readonly synchronize?: typeof synchronizeLaunchPreferences;
  readonly timeoutMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly maxAttempts?: number;
  readonly attemptWindowMs?: number;
  readonly externalRetryCooldownMs?: number;
  readonly subscribeRetry?: (listener: TelegramBootstrapRetryListener) => VoidFunction;
}

function isRetryableBootstrapError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('retryable' in error)) return true;
  return error.retryable !== false;
}

function subscribeTelegramBootstrapRetry(listener: TelegramBootstrapRetryListener): VoidFunction {
  const hasGlobalEvents = typeof globalThis.addEventListener === 'function';
  const hasDocument = typeof document !== 'undefined';
  const onOnline = () => listener('online');
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') listener('visible');
  };
  if (hasGlobalEvents) globalThis.addEventListener('online', onOnline);
  if (hasDocument) document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    if (hasGlobalEvents) globalThis.removeEventListener('online', onOnline);
    if (hasDocument) document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export function startTelegramPreferenceBootstrap({
  platform,
  onReady,
  synchronize = synchronizeLaunchPreferences,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
  attemptTimeoutMs = BOOTSTRAP_ATTEMPT_TIMEOUT_MS,
  retryDelaysMs = BOOTSTRAP_RETRY_DELAYS_MS,
  maxAttempts = BOOTSTRAP_MAX_ATTEMPTS,
  attemptWindowMs = BOOTSTRAP_ATTEMPT_WINDOW_MS,
  externalRetryCooldownMs = BOOTSTRAP_EXTERNAL_RETRY_COOLDOWN_MS,
  subscribeRetry = subscribeTelegramBootstrapRetry,
}: TelegramBootstrapOptions): VoidFunction {
  let cancelled = false;
  let finished = false;
  let retryIndex = 0;
  let attemptStarts: number[] = [];
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let retryId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let externalRetryId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let activeTimeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let activeController: AbortController | undefined;
  let retryPending = false;
  let attemptRunning = false;
  let externalSignalPending = false;
  let identityIsolated = false;
  let splashDeadlineReached = false;
  const release = () => {
    if (cancelled || finished || !identityIsolated) return;
    finished = true;
    globalThis.clearTimeout(splashTimeoutId);
    onReady();
  };
  const markIdentityIsolated = () => {
    if (cancelled) return;
    identityIsolated = true;
    if (splashDeadlineReached) release();
  };
  const splashTimeoutId = globalThis.setTimeout(() => {
    splashDeadlineReached = true;
    release();
  }, timeoutMs);

  const hasAttemptBudget = (now: number): boolean => {
    attemptStarts = attemptStarts.filter((startedAt) => now - startedAt < attemptWindowMs);
    return attemptStarts.length < maxAttempts;
  };

  const scheduleRetry = (): boolean => {
    if (
      cancelled ||
      !retryPending ||
      !hasAttemptBudget(Date.now()) ||
      retryIndex >= retryDelaysMs.length
    ) {
      return false;
    }
    const delayMs = retryDelaysMs[retryIndex++];
    retryId = globalThis.setTimeout(runAttempt, delayMs);
    return true;
  };

  const runAttempt = () => {
    retryId = undefined;
    const startedAt = Date.now();
    if (cancelled || !hasAttemptBudget(startedAt)) return;
    retryPending = false;
    attemptRunning = true;
    attemptStarts.push(startedAt);
    lastAttemptAt = startedAt;
    const controller = new AbortController();
    activeController = controller;
    let settled = false;
    const settle = (retry: boolean) => {
      if (settled) return;
      settled = true;
      attemptRunning = false;
      globalThis.clearTimeout(timeoutId);
      if (activeTimeoutId === timeoutId) activeTimeoutId = undefined;
      if (activeController === controller) activeController = undefined;
      retryPending = retry;
      if (!retry) {
        externalSignalPending = false;
        release();
        return;
      }
      if (scheduleRetry()) {
        // The already-scheduled attempt observes the recovered connection.
        externalSignalPending = false;
      } else if (externalSignalPending) {
        consumeExternalSignal();
      }
    };
    const timeoutId = globalThis.setTimeout(() => {
      controller.abort();
      // A provider or a contended Web Lock may ignore cancellation. Release the
      // splash and continue with a fresh, bounded background attempt regardless.
      settle(true);
    }, attemptTimeoutMs);
    activeTimeoutId = timeoutId;

    void synchronize(platform, controller.signal, undefined, () => {
      if (!settled) markIdentityIsolated();
    }).then(
      (result) => {
        if (settled || cancelled) return;
        // A fulfilled synchronization has crossed the isolation boundary even
        // when a test double omits the explicit callback.
        markIdentityIsolated();
        settle(result === 'retry');
      },
      (error: unknown) => {
        if (settled || cancelled) return;
        const message = error instanceof Error ? error.message : 'unknown bootstrap error';
        console.warn(`[telegram] preferences bootstrap failed: ${message}`);
        settle(isRetryableBootstrapError(error));
      },
    );
  };

  const consumeExternalSignal = () => {
    if (
      cancelled ||
      !retryPending ||
      attemptRunning ||
      retryId !== undefined ||
      externalRetryId !== undefined
    ) {
      return;
    }
    const now = Date.now();
    if (!hasAttemptBudget(now)) {
      // Do not wake up later from a stale foreground edge. A new signal after
      // the rolling window has quieted may recover without remounting.
      externalSignalPending = false;
      return;
    }
    const cooldownRemainingMs = externalRetryCooldownMs - (now - lastAttemptAt);
    if (cooldownRemainingMs > 0) {
      // Foreground churn is common in Telegram. One timer retains the first
      // recovery edge and coalesces all later visibility/online signals.
      externalRetryId = globalThis.setTimeout(() => {
        externalRetryId = undefined;
        consumeExternalSignal();
      }, cooldownRemainingMs);
      return;
    }
    externalSignalPending = false;
    retryIndex = 0;
    runAttempt();
  };

  const retryOnExternalSignal: TelegramBootstrapRetryListener = () => {
    if (cancelled) return;
    if (attemptRunning) {
      externalSignalPending = true;
      return;
    }
    if (!retryPending) return;
    externalSignalPending = true;
    if (retryId !== undefined) {
      // The pending ladder attempt is itself the recovery probe.
      externalSignalPending = false;
      return;
    }
    consumeExternalSignal();
  };

  const unsubscribeRetry = subscribeRetry(retryOnExternalSignal);
  runAttempt();

  return () => {
    cancelled = true;
    globalThis.clearTimeout(splashTimeoutId);
    if (retryId !== undefined) globalThis.clearTimeout(retryId);
    if (externalRetryId !== undefined) globalThis.clearTimeout(externalRetryId);
    if (activeTimeoutId !== undefined) globalThis.clearTimeout(activeTimeoutId);
    activeController?.abort();
    unsubscribeRetry();
  };
}

export function BootstrapGate({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const [ready, setReady] = useState(!platform.isTelegram);
  const locale = useUiStore((state) => state.locale);

  useEffect(() => {
    if (!platform.isTelegram) return;
    return startTelegramPreferenceBootstrap({
      platform,
      onReady: () => setReady(true),
    });
  }, [platform]);

  if (ready) return children;

  return (
    <div
      className="flex min-h-[var(--app-height)] items-center justify-center bg-bg px-6 text-ink"
      role="status"
      aria-live="polite"
      aria-label={translate(locale, 'app.telegramSync')}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="relative flex size-16 items-center justify-center rounded-full border border-line bg-surface">
          <span className="absolute inset-2 rounded-full bg-ivory/5" aria-hidden="true" />
          <CometMark size={30} className="relative text-ivory" />
        </div>
        <div className="text-center">
          <div className="text-[1.0625rem] font-semibold tracking-tight">{APP_NAME}</div>
          <div className="mt-1 text-[0.8125rem] text-ink-3">
            {translate(locale, 'app.telegramSync')}
          </div>
        </div>
        <span className="h-0.5 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span className="block h-full w-1/2 animate-pulse rounded-full bg-ivory" />
        </span>
      </div>
    </div>
  );
}
