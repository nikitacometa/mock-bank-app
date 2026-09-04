import { TelegramApiError } from './bot-api.js';
import type { ServiceLogger } from './logger.js';
import { PreferencesRepository } from './repository.js';
import type { TelegramUpdate } from './telegram.js';

const POLL_TIMEOUT_SECONDS = 25;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;
const MAX_UPDATE_ATTEMPTS = 5;
const UNHEALTHY_FAILURE_COUNT = 5;

type Random = () => number;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface PollingClient {
  getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
}

export interface UpdateHandler {
  handleUpdate(update: TelegramUpdate, signal?: AbortSignal): Promise<void>;
  flushPendingReplies?(signal?: AbortSignal): Promise<void>;
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isFatalProviderError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code === 401 || code === 404;
}

function isTerminalUpdateError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code === 400 || code === 403;
}

function errorContext(error: unknown): Readonly<Record<string, string | number>> {
  if (error instanceof TelegramApiError) {
    return {
      errorType: error.name,
      status: error.status,
      ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
    };
  }
  return { errorType: error instanceof Error ? error.name : 'unknown' };
}

export class LongPoller {
  readonly #client: PollingClient;
  readonly #engine: UpdateHandler;
  readonly #repository: PreferencesRepository;
  readonly #logger: ServiceLogger;
  readonly #random: Random;
  readonly #sleep: Sleep;
  readonly #updateAttempts = new Map<number, number>();
  #running = false;
  #hasSuccessfulPoll = false;
  #consecutiveFailures = 0;

  constructor(
    client: PollingClient,
    engine: UpdateHandler,
    repository: PreferencesRepository,
    logger: ServiceLogger,
    random: Random = Math.random,
    sleep: Sleep = abortableDelay,
  ) {
    this.#client = client;
    this.#engine = engine;
    this.#repository = repository;
    this.#logger = logger;
    this.#random = random;
    this.#sleep = sleep;
  }

  health(): { readonly running: boolean; readonly healthy: boolean; readonly consecutiveFailures: number } {
    return {
      running: this.#running,
      healthy:
        this.#running &&
        this.#hasSuccessfulPoll &&
        this.#consecutiveFailures < UNHEALTHY_FAILURE_COUNT,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error('Long polling worker is already running');
    this.#running = true;
    this.#hasSuccessfulPoll = false;
    this.#consecutiveFailures = 0;
    try {
      while (!signal.aborted) {
        try {
          const offset = this.#repository.preparePolling();
          const updates = await this.#client.getUpdates(offset, POLL_TIMEOUT_SECONDS, signal);
          this.#hasSuccessfulPoll = true;
          const orderedUpdates = [...updates].sort((left, right) => left.updateId - right.updateId);
          for (const update of orderedUpdates) {
            if (signal.aborted) return;
            if (!this.#repository.hasProcessedUpdate(update.updateId)) {
              try {
                await this.#engine.handleUpdate(update, signal);
              } catch (error: unknown) {
                if (signal.aborted) return;
                if (isFatalProviderError(error)) throw error;
                const attempts = (this.#updateAttempts.get(update.updateId) ?? 0) + 1;
                this.#updateAttempts.set(update.updateId, attempts);
                this.#logger.warn('telegram_update_failed', {
                  updateId: update.updateId,
                  attempts,
                  ...errorContext(error),
                });
                if (!isTerminalUpdateError(error) && attempts < MAX_UPDATE_ATTEMPTS) {
                  throw error;
                }
                this.#logger.error('telegram_update_dropped', {
                  updateId: update.updateId,
                  attempts,
                  ...errorContext(error),
                });
              }
              this.#repository.markProcessed(update.updateId);
              this.#updateAttempts.delete(update.updateId);
            }
            if (update.updateId === Number.MAX_SAFE_INTEGER) {
              throw new Error('Telegram update offset overflow');
            }
          }
          this.#consecutiveFailures = 0;
          if (!signal.aborted && this.#engine.flushPendingReplies !== undefined) {
            try {
              await this.#engine.flushPendingReplies(signal);
            } catch (error: unknown) {
              if (signal.aborted) return;
              if (isFatalProviderError(error)) throw error;
              this.#logger.warn('telegram_outbox_flush_failed', errorContext(error));
            }
          }
        } catch (error: unknown) {
          if (signal.aborted) return;
          if (isFatalProviderError(error)) throw error;
          this.#consecutiveFailures += 1;
          const exponential = Math.min(
            MAX_BACKOFF_MS,
            INITIAL_BACKOFF_MS * 2 ** Math.min(this.#consecutiveFailures - 1, 8),
          );
          const jittered = Math.round(exponential * (0.8 + this.#random() * 0.4));
          const retryAfter = error instanceof TelegramApiError
            ? Math.min((error.retryAfter ?? 0) * 1_000, MAX_RETRY_AFTER_MS)
            : 0;
          const retryMs = Math.max(jittered, retryAfter);
          this.#logger.warn('telegram_poll_failed', {
            attempt: this.#consecutiveFailures,
            retryMs,
            ...errorContext(error),
          });
          await this.#sleep(retryMs, signal);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
