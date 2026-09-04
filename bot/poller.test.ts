import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramApiError } from './bot-api.js';
import type { ServiceLogger } from './logger.js';
import { OnboardingEngine } from './onboarding.js';
import {
  abortableDelay,
  LongPoller,
  type PollingClient,
  type UpdateHandler,
} from './poller.js';
import {
  PreferencesRepository,
  UPDATE_SEQUENCE_RESET_AFTER_MS,
} from './repository.js';
import type { BotTransport, TelegramUpdate } from './telegram.js';

const silentLogger: ServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function update(updateId: number): TelegramUpdate {
  return { updateId };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LongPoller', () => {
  it('stays unready until the first successful Telegram poll', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    let pollCount = 0;
    let resolveFirstPoll: ((updates: readonly TelegramUpdate[]) => void) | undefined;
    const firstPoll = new Promise<readonly TelegramUpdate[]>((resolve) => {
      resolveFirstPoll = resolve;
    });
    const client: PollingClient = {
      getUpdates: async (_offset, _timeout, signal) => {
        pollCount += 1;
        if (pollCount === 1) return firstPoll;
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
    };
    const poller = new LongPoller(
      client,
      { handleUpdate: async () => undefined },
      repository,
      silentLogger,
    );
    const running = poller.run(abort.signal);
    try {
      await vi.waitFor(() => expect(pollCount).toBe(1));
      expect(poller.health()).toEqual({
        running: true,
        healthy: false,
        consecutiveFailures: 0,
      });

      resolveFirstPoll?.([]);
      await vi.waitFor(() => expect(pollCount).toBe(2));
      expect(poller.health()).toEqual({
        running: true,
        healthy: true,
        consecutiveFailures: 0,
      });
    } finally {
      abort.abort();
      resolveFirstPoll?.([]);
      await running;
      repository.close();
    }
  });

  it('processes a non-contiguous batch in order and persists the highest offset', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    const offsets: (number | undefined)[] = [];
    const handled: number[] = [];
    const client: PollingClient = {
      getUpdates: async (offset, timeout) => {
        offsets.push(offset);
        expect(timeout).toBe(25);
        return [update(43), update(41)];
      },
    };
    const handler: UpdateHandler = {
      handleUpdate: async (item) => {
        handled.push(item.updateId);
        if (item.updateId === 43) abort.abort();
      },
    };
    try {
      await new LongPoller(client, handler, repository, silentLogger).run(abort.signal);

      expect(offsets).toEqual([undefined]);
      expect(handled).toEqual([41, 43]);
      expect(repository.nextUpdateOffset()).toBe(44);
    } finally {
      repository.close();
    }
  });

  it('threads its shutdown signal through update handling and outbox drain', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    let updateSignal: AbortSignal | undefined;
    let drainSignal: AbortSignal | undefined;
    const client: PollingClient = { getUpdates: async () => [update(41)] };
    const handler: UpdateHandler = {
      handleUpdate: async (_item, signal) => {
        updateSignal = signal;
      },
      flushPendingReplies: async (signal) => {
        drainSignal = signal;
        abort.abort();
      },
    };
    try {
      await new LongPoller(client, handler, repository, silentLogger).run(abort.signal);

      expect(updateSignal).toBe(abort.signal);
      expect(drainSignal).toBe(abort.signal);
      expect(repository.hasProcessedUpdate(41)).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('skips a persisted duplicate after restart', async () => {
    const repository = new PreferencesRepository(':memory:');
    repository.markProcessed(41);
    const abort = new AbortController();
    const handled: number[] = [];
    const client: PollingClient = {
      getUpdates: async () => [update(41), update(43)],
    };
    const handler: UpdateHandler = {
      handleUpdate: async (item) => {
        handled.push(item.updateId);
        abort.abort();
      },
    };
    try {
      await new LongPoller(client, handler, repository, silentLogger).run(abort.signal);

      expect(handled).toEqual([43]);
      expect(repository.nextUpdateOffset()).toBe(44);
    } finally {
      repository.close();
    }
  });

  it('processes a lower randomized update ID after continuous empty polls cross the idle reset', async () => {
    let nowMs = 1_700_000_000_000;
    const repository = new PreferencesRepository(':memory:', () => new Date(nowMs));
    repository.markProcessed(900_000);
    const abort = new AbortController();
    const offsets: (number | undefined)[] = [];
    const handled: number[] = [];
    const client: PollingClient = {
      getUpdates: async (offset) => {
        offsets.push(offset);
        if (offset !== undefined) {
          nowMs += UPDATE_SEQUENCE_RESET_AFTER_MS;
          return [];
        }
        return [update(17)];
      },
    };
    const handler: UpdateHandler = {
      handleUpdate: async (item) => {
        handled.push(item.updateId);
        abort.abort();
      },
    };
    try {
      await new LongPoller(client, handler, repository, silentLogger).run(abort.signal);

      expect(offsets).toEqual([900_001, undefined]);
      expect(handled).toEqual([17]);
      expect(repository.hasProcessedUpdate(900_000)).toBe(false);
      expect(repository.hasProcessedUpdate(17)).toBe(true);
      expect(repository.nextUpdateOffset()).toBe(18);
    } finally {
      repository.close();
    }
  });

  it('does not acknowledge the failing update and stops retry sleep on abort', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    const retries: number[] = [];
    const client: PollingClient = {
      getUpdates: async () => [update(41), update(43)],
    };
    const handler: UpdateHandler = {
      handleUpdate: async (item) => {
        if (item.updateId === 43) throw new Error('synthetic handler failure');
      },
    };
    try {
      await new LongPoller(
        client,
        handler,
        repository,
        silentLogger,
        () => 0.5,
        async (milliseconds) => {
          retries.push(milliseconds);
          abort.abort();
        },
      ).run(abort.signal);

      expect(repository.hasProcessedUpdate(41)).toBe(true);
      expect(repository.hasProcessedUpdate(43)).toBe(false);
      expect(repository.nextUpdateOffset()).toBe(42);
      expect(retries).toEqual([500]);
    } finally {
      repository.close();
    }
  });

  it('polls first and stays healthy when a pending-reply drain transiently fails', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    let flushAttempts = 0;
    let polls = 0;
    const events: string[] = [];
    const sleeps = vi.fn(async () => undefined);
    const client: PollingClient = {
      getUpdates: async (_offset, _timeout, signal) => {
        polls += 1;
        events.push('poll');
        if (polls === 1) return [];
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
    };
    const handler: UpdateHandler = {
      handleUpdate: async () => undefined,
      flushPendingReplies: async () => {
        flushAttempts += 1;
        events.push('flush');
        throw new Error('pending reply unavailable');
      },
    };
    const warnings: string[] = [];
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: (event) => warnings.push(event),
      error: () => undefined,
    };
    const poller = new LongPoller(
      client,
      handler,
      repository,
      logger,
      () => 0.5,
      sleeps,
    );
    const running = poller.run(abort.signal);
    try {
      await vi.waitFor(() => expect(polls).toBe(2));
      expect(events).toEqual(['poll', 'flush', 'poll']);
      expect(flushAttempts).toBe(1);
      expect(poller.health()).toEqual({
        running: true,
        healthy: true,
        consecutiveFailures: 0,
      });
      expect(warnings).toEqual(['telegram_outbox_flush_failed']);
      expect(sleeps).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await running;
      repository.close();
    }
  });

  it('drops a blocked-user 403 reply then drains other replies before polling again', async () => {
    const repository = new PreferencesRepository(':memory:');
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.ensureUser({
      telegramUserId: '43',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Grace',
    });
    repository.applyCustomNameIntent('42', '42', 700, 'Ada');
    repository.applyCustomNameIntent('43', '43', 701, 'Grace');
    const abort = new AbortController();
    const delivered: string[] = [];
    const warnings: string[] = [];
    const transport: BotTransport = {
      sendMessage: async (input) => {
        if (input.chatId === '42') {
          throw new TelegramApiError('sendMessage', 403, 403);
        }
        delivered.push(input.chatId);
        abort.abort();
      },
      answerCallbackQuery: async () => undefined,
      setUserMenuButton: async () => undefined,
    };
    const engine = new OnboardingEngine(
      repository,
      transport,
      new URL('https://euphoria.bot/'),
      { warn: (event) => warnings.push(event) },
      async () => undefined,
    );
    let polls = 0;
    const client: PollingClient = {
      getUpdates: async () => {
        polls += 1;
        return [];
      },
    };
    try {
      await new LongPoller(client, engine, repository, silentLogger).run(abort.signal);

      expect(delivered).toEqual(['43']);
      expect(repository.getPendingReply(700)).toBeNull();
      expect(repository.getPendingReply(701)).toBeNull();
      expect(warnings).toEqual(['telegram_pending_reply_rejected']);
      expect(polls).toBe(1);
    } finally {
      repository.close();
    }
  });

  it('refuses a second concurrent worker', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    const client: PollingClient = {
      getUpdates: async (_offset, _timeout, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        }),
    };
    const handler: UpdateHandler = { handleUpdate: async () => undefined };
    const poller = new LongPoller(client, handler, repository, silentLogger);
    try {
      const running = poller.run(abort.signal);
      await Promise.resolve();
      await expect(poller.run(abort.signal)).rejects.toThrow('already running');
      abort.abort();
      await running;
    } finally {
      repository.close();
    }
  });

  it('drops one poison update after bounded retries and continues with the batch', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    const handled: number[] = [];
    const dropped: Array<Readonly<Record<string, string | number | boolean>>> = [];
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (event, context) => {
        if (event === 'telegram_update_dropped' && context !== undefined) dropped.push(context);
      },
    };
    const client: PollingClient = { getUpdates: async () => [update(41), update(43)] };
    const handler: UpdateHandler = {
      handleUpdate: async (item) => {
        handled.push(item.updateId);
        if (item.updateId === 41) throw new Error('synthetic poison update');
        abort.abort();
      },
    };
    try {
      await new LongPoller(
        client,
        handler,
        repository,
        logger,
        () => 0.5,
        async () => undefined,
      ).run(abort.signal);

      expect(handled).toEqual([41, 41, 41, 41, 41, 43]);
      expect(repository.hasProcessedUpdate(41)).toBe(true);
      expect(repository.hasProcessedUpdate(43)).toBe(true);
      expect(repository.nextUpdateOffset()).toBe(44);
      expect(dropped).toEqual([
        expect.objectContaining({ updateId: 41, attempts: 5, errorType: 'Error' }),
      ]);
    } finally {
      repository.close();
    }
  });

  it('honours Telegram retry_after and reports an unhealthy sustained poll loop', async () => {
    const repository = new PreferencesRepository(':memory:');
    const abort = new AbortController();
    const retries: number[] = [];
    const client: PollingClient = {
      getUpdates: async () => {
        throw new TelegramApiError('getUpdates', 429, 429, 37);
      },
    };
    const handler: UpdateHandler = { handleUpdate: async () => undefined };
    const poller = new LongPoller(
      client,
      handler,
      repository,
      silentLogger,
      () => 0,
      async (milliseconds) => {
        retries.push(milliseconds);
        if (retries.length === 5) abort.abort();
      },
    );
    try {
      await poller.run(abort.signal);

      expect(retries).toEqual([37_000, 37_000, 37_000, 37_000, 37_000]);
      expect(poller.health()).toEqual({
        running: false,
        healthy: false,
        consecutiveFailures: 5,
      });
    } finally {
      repository.close();
    }
  });

  it('fails the worker immediately when Telegram rejects the bot credential', async () => {
    const repository = new PreferencesRepository(':memory:');
    const sleep = vi.fn(async () => undefined);
    const client: PollingClient = {
      getUpdates: async () => {
        throw new TelegramApiError('getUpdates', 401, 401);
      },
    };
    try {
      await expect(
        new LongPoller(
          client,
          { handleUpdate: async () => undefined },
          repository,
          silentLogger,
          Math.random,
          sleep,
        ).run(new AbortController().signal),
      ).rejects.toMatchObject({ name: 'TelegramApiError', errorCode: 401 });
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      repository.close();
    }
  });

  it('removes the abort listener when the normal delay timer wins', async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const removeListener = vi.spyOn(signal, 'removeEventListener');

    const pending = abortableDelay(250, signal);
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
