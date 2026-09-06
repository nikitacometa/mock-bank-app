import { useEffect, useState, type ReactNode } from 'react';
import { translate } from '@/i18n/catalog';
import { usePlatform } from '@/platform/usePlatform';
import type { PlatformAdapter } from '@/platform/types';
import { useUiStore } from '@/store/uiStore';
import { useBankStore } from '@/store/bankStore';
import { CometMark } from '@/ui/icons';
import { APP_NAME } from './config';
import {
  quarantineTelegramLaunchSession,
  shouldSettleAfterTelegramForegroundSync,
  synchronizeLaunchPreferences,
  type LaunchPreferenceSyncResult,
} from './launchPreferences';

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
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onSynchronized?: (result: LaunchPreferenceSyncResult, signal: AbortSignal) => void;
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
  const onPageShow = (event: Event) => {
    if ('persisted' in event && event.persisted === true) listener('visible');
  };
  if (hasGlobalEvents) globalThis.addEventListener('online', onOnline);
  if (hasGlobalEvents) globalThis.addEventListener('pageshow', onPageShow);
  if (hasDocument) document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    if (hasGlobalEvents) globalThis.removeEventListener('online', onOnline);
    if (hasGlobalEvents) globalThis.removeEventListener('pageshow', onPageShow);
    if (hasDocument) document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export function startTelegramPreferenceBootstrap({
  platform,
  onReady,
  onPendingChange,
  onSynchronized,
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
  let cancelActiveAttempt: VoidFunction | undefined;
  let boundaryController: AbortController | undefined;
  let observedFingerprint = platform.getSessionFingerprint?.();
  let hasObservedFingerprint = observedFingerprint !== undefined;
  let idleRefreshAllowed = false;
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
    if (cancelled || attemptRunning || !hasAttemptBudget(startedAt)) return;
    retryPending = false;
    attemptRunning = true;
    onPendingChange?.(true);
    attemptStarts.push(startedAt);
    lastAttemptAt = startedAt;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    observedFingerprint = platform.getSessionFingerprint?.();
    if (observedFingerprint !== undefined) hasObservedFingerprint = true;
    const isForeground = finished;
    let settled = false;
    const settle = (retry: boolean, automaticRetry = true) => {
      if (settled) return;
      settled = true;
      attemptRunning = false;
      if (!cancelled) onPendingChange?.(false);
      globalThis.clearTimeout(timeoutId);
      if (activeTimeoutId === timeoutId) activeTimeoutId = undefined;
      cancelActiveAttempt = undefined;
      retryPending = retry;
      if (!retry) {
        externalSignalPending = false;
        release();
        return;
      }
      if (automaticRetry && scheduleRetry()) {
        // The already-scheduled attempt observes the recovered connection.
        externalSignalPending = false;
      } else if (externalSignalPending) {
        consumeExternalSignal();
      }
    };
    cancelActiveAttempt = () => {
      controller.abort();
      settle(true, false);
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
        const retry = result === 'retry' || (result === 'absent' && !hasObservedFingerprint);
        idleRefreshAllowed = !retry;
        settle(retry);
        if (isForeground) onSynchronized?.(result, controller.signal);
      },
      (error: unknown) => {
        if (settled || cancelled) return;
        const message = error instanceof Error ? error.message : 'unknown bootstrap error';
        console.warn(`[telegram] preferences bootstrap failed: ${message}`);
        const retryable = isRetryableBootstrapError(error);
        if (!retryable) idleRefreshAllowed = false;
        settle(retryable);
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
    const fingerprint = platform.getSessionFingerprint?.();
    const identityChanged = observedFingerprint !== undefined && fingerprint !== observedFingerprint;
    const resumeAbsentColdLaunch = !hasObservedFingerprint && fingerprint !== undefined && !attemptRunning;
    if (fingerprint !== undefined) hasObservedFingerprint = true;
    // First SDK availability is not an account switch. The in-flight sync
    // checks its own captured fingerprint and retries on the short cold ladder.
    if (!identityChanged) observedFingerprint = fingerprint;
    if (identityChanged) {
      // Quarantine is not an HTTP retry and must never wait for its cooldown.
      // The store hides the old namespace synchronously before the first await.
      observedFingerprint = fingerprint;
      boundaryController?.abort();
      boundaryController = new AbortController();
      const signal = boundaryController.signal;
      void quarantineTelegramLaunchSession(platform, signal).catch((error: unknown) => {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : 'unknown identity error';
        console.warn(`[telegram] foreground identity isolation failed: ${message}`);
      });
      externalSignalPending = true;
      idleRefreshAllowed = true;
      activeController?.abort();
      cancelActiveAttempt?.();
    }
    if (attemptRunning) {
      externalSignalPending = true;
      return;
    }
    if (resumeAbsentColdLaunch) {
      // A completed `absent` probe has no verified session to refresh. SDK
      // availability resumes its cold ladder, not the 30-second foreground lane.
      if (retryId !== undefined) globalThis.clearTimeout(retryId);
      if (externalRetryId !== undefined) globalThis.clearTimeout(externalRetryId);
      retryId = undefined;
      externalRetryId = undefined;
      externalSignalPending = false;
      retryPending = true;
      retryIndex = 0;
      if (scheduleRetry()) return;
    }
    if (!retryPending && !idleRefreshAllowed) return;
    retryPending = true;
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
    boundaryController?.abort();
    unsubscribeRetry();
  };
}

export function BootstrapGate({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const [ready, setReady] = useState(!platform.isTelegram);
  const [syncPending, setSyncPending] = useState(false);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [manualRetry, setManualRetry] = useState(0);
  const locale = useUiStore((state) => state.locale);
  const ledgerMode = useBankStore((state) => state.ledgerMode);
  const ledgerSyncError = useBankStore((state) => state.ledgerSyncError);
  const approveServerCopy = useBankStore((state) => state.approveServerCopy);

  useEffect(() => {
    if (!platform.isTelegram) return;
    return startTelegramPreferenceBootstrap({
      platform,
      onReady: () => setReady(true),
      onPendingChange: (pending) => {
        setSyncPending(pending);
        if (!pending) setRecoveryVisible(useBankStore.getState().ledgerMode === 'read_only');
      },
      onSynchronized: (result, signal) => {
        if (
          signal.aborted ||
          document.visibilityState !== 'visible' ||
          !shouldSettleAfterTelegramForegroundSync(result)
        ) return;
        const fingerprint = platform.getSessionFingerprint?.();
        void useBankStore.getState().settleNow().then(() => {
          if (
            signal.aborted ||
            document.visibilityState !== 'visible' ||
            fingerprint !== platform.getSessionFingerprint?.() ||
            useBankStore.getState().ledgerMode === 'read_only'
          ) return;
          // Local rates already implement freshness caching; server mode asks
          // its authority and never calls the public provider from the client.
          return useBankStore.getState().refreshRates();
        }).catch((error: unknown) => {
          if (signal.aborted) return;
          const message = error instanceof Error ? error.message : 'unknown settlement error';
          console.warn(`[telegram] foreground settlement failed: ${message}`);
        });
      },
    });
  }, [manualRetry, platform]);

  if (ready && ledgerMode !== 'read_only') return children;

  if (ready && (recoveryVisible || !syncPending || ledgerSyncError === 'server_copy_confirmation_required')) {
    const needsServerCopyConfirmation =
      ledgerSyncError === 'server_copy_confirmation_required';
    const recovering = syncPending && !needsServerCopyConfirmation;
    return (
      <div
        className="flex min-h-[var(--app-height)] items-center justify-center bg-bg px-6 text-ink"
        role="status"
        aria-live="polite"
      >
        <div className="max-w-72 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-line bg-surface">
            <CometMark size={30} className="text-ivory" />
          </div>
          <h1 className="mt-5 text-[1.25rem] font-semibold tracking-tight">
            {needsServerCopyConfirmation
              ? locale === 'ru'
                ? 'На сервере уже есть ваше демо'
                : 'Your server demo is already active'
              : recovering
                ? locale === 'ru'
                  ? 'Синхронизируем с Cometa'
                  : 'Syncing with Cometa'
              : locale === 'ru'
                ? 'Счета пока только для чтения'
                : 'Accounts are read-only for now'}
          </h1>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-ink-3">
            {needsServerCopyConfirmation
              ? locale === 'ru'
                ? 'Первая загруженная версия стала основной. Локальная история этого устройства не объединяется и останется без изменений, пока вы не выберете серверную копию.'
                : 'The first imported version is canonical. This device’s local history will not be merged or changed until you choose the server copy.'
              : recovering
                ? locale === 'ru'
                  ? 'Сверяем историю с сервером. Счета откроются после синхронизации.'
                  : 'Checking your history with the server. Accounts will reopen when synchronization finishes.'
              : locale === 'ru'
                ? 'Не удалось завершить синхронизацию. Повторите попытку, чтобы проверить состояние счетов.'
                : 'Cometa could not sync safely. Try again to check the latest account state.'}
          </p>
          <button
            type="button"
            className="mt-6 min-h-11 rounded-full bg-ivory px-5 text-[0.875rem] font-semibold text-bg aria-disabled:opacity-50"
            aria-disabled={recovering}
            onClick={() => {
              if (recovering) return;
              if (needsServerCopyConfirmation && !approveServerCopy()) return;
              setReady(false);
              setRecoveryVisible(false);
              setManualRetry((value) => value + 1);
            }}
          >
            {needsServerCopyConfirmation
              ? locale === 'ru'
                ? 'Использовать серверную копию'
                : 'Use server copy'
              : locale === 'ru'
                ? 'Повторить'
                : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

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
