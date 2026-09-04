import { describe, expect, it } from 'vitest';
import { BotApiClient, TelegramApiError } from './bot-api.js';
import { reconcileWebhook, setupBotForPolling, setupBotProfile } from './setup.js';
import type { ServiceLogger } from './logger.js';

const TOKEN = ['123456', 'synthetic_token_that_is_long_enough_for_tests'].join(':');
const WEB_APP_URL = new URL('https://euphoria.bot/');

interface CapturedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function jsonResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status >= 200 && status < 300, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function telegramErrorResponse(errorCode: number, retryAfter?: number): Response {
  return new Response(JSON.stringify({
    ok: false,
    error_code: errorCode,
    description: 'Synthetic provider failure',
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  }), {
    status: errorCode,
    headers: { 'content-type': 'application/json' },
  });
}

function capturingFetch(
  results: readonly Response[],
  calls: CapturedCall[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let index = 0;
  return async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = results[index++];
    if (response === undefined) throw new Error('Unexpected test request');
    return response;
  };
}

describe('BotApiClient', () => {
  it('reconciles an existing webhook without dropping pending updates', async () => {
    const calls: CapturedCall[] = [];
    const client = new BotApiClient(
      TOKEN,
      WEB_APP_URL,
      capturingFetch([
        jsonResponse({ url: 'https://old.invalid/hook', pending_update_count: 7 }),
        jsonResponse(true),
        jsonResponse({ url: '', pending_update_count: 7 }),
      ], calls),
    );

    await reconcileWebhook(client, new AbortController().signal);

    expect(calls.map((call) => new URL(call.url).pathname.split('/').at(-1)))
      .toEqual(['getWebhookInfo', 'deleteWebhook', 'getWebhookInfo']);
    expect(calls[1]?.body).toEqual({ drop_pending_updates: false });
  });

  it('uses a positive long-poll timeout, explicit allowlist, and validates updates', async () => {
    const calls: CapturedCall[] = [];
    const client = new BotApiClient(
      TOKEN,
      WEB_APP_URL,
      capturingFetch([
        jsonResponse([{
          update_id: 43,
          message: {
            message_id: 9,
            chat: { id: 42, type: 'private' },
            from: { id: 42, first_name: 'Ada' },
            text: '/start',
          },
        }]),
      ], calls),
    );

    const updates = await client.getUpdates(42, 25);

    expect(updates).toEqual([{
      updateId: 43,
      message: {
        messageId: 9,
        chat: { id: '42', type: 'private' },
        from: { id: '42', firstName: 'Ada' },
        text: '/start',
      },
      callbackQuery: undefined,
    }]);
    expect(calls[0]?.body).toEqual({
      offset: 42,
      timeout: 25,
      limit: 50,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(calls[0]?.url.startsWith('https://api.telegram.org/')).toBe(true);
    await expect(client.getUpdates(undefined, 0)).rejects.toThrow('positive integer');
  });

  it('puts private-chat menu localization and all user values in JSON, never the method URL', async () => {
    const calls: CapturedCall[] = [];
    const client = new BotApiClient(
      TOKEN,
      WEB_APP_URL,
      capturingFetch([jsonResponse(true), jsonResponse({ message_id: 1 })], calls),
    );

    await client.setUserMenuButton('424242', 'ru');
    await client.sendMessage({ chatId: '424242', text: 'Ada &amp; Bob' });

    expect(calls[0]?.body).toEqual({
      chat_id: 424242,
      menu_button: {
        type: 'web_app',
        text: 'Открыть Cometa',
        web_app: { url: 'https://euphoria.bot/' },
      },
    });
    expect(calls[1]?.body).toMatchObject({ chat_id: '424242', text: 'Ada &amp; Bob' });
    expect(calls[1]?.url).not.toContain('424242');
    expect(calls[1]?.url).not.toContain('Ada');
  });

  it('forwards one caller signal to message, callback, and private-menu requests', async () => {
    const requestSignals: AbortSignal[] = [];
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async (_input, init) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error('Missing request signal');
      requestSignals.push(init.signal);
      return jsonResponse(true);
    });
    const abort = new AbortController();

    await client.sendMessage({ chatId: '42', text: 'Hello' }, abort.signal);
    await client.answerCallbackQuery('callback-1', undefined, abort.signal);
    await client.setUserMenuButton('42', 'en', abort.signal);
    abort.abort();

    expect(requestSignals).toHaveLength(3);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('cancels an in-flight outbound message request on worker abort', async () => {
    let observedSignal: AbortSignal | undefined;
    let announceFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      announceFetch = resolve;
    });
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async (_input, init) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error('Missing request signal');
      observedSignal = init.signal;
      announceFetch?.();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const abort = new AbortController();

    const sending = client.sendMessage({ chatId: '42', text: 'Hello' }, abort.signal);
    await fetchStarted;
    abort.abort();

    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('rejects a private menu chat ID that cannot be represented exactly as Bot API Integer', async () => {
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async () => {
      throw new Error('fetch must not run');
    });

    await expect(client.setUserMenuButton('9007199254740993', 'en'))
      .rejects.toThrow('Invalid private chat ID');
  });

  it('configures the bot profile, localized commands, and default Web App menu', async () => {
    const calls: CapturedCall[] = [];
    const responses = [jsonResponse({ id: 1, is_bot: true })];
    responses.push(...Array.from({ length: 13 }, () => jsonResponse(true)));
    const client = new BotApiClient(TOKEN, WEB_APP_URL, capturingFetch(responses, calls));

    await setupBotProfile(client, new AbortController().signal);

    const methods = calls.map((call) => new URL(call.url).pathname.split('/').at(-1));
    expect(methods).toEqual([
      'getMe',
      'setChatMenuButton',
      'setMyCommands',
      'setMyCommands',
      'setMyCommands',
      'setMyName',
      'setMyName',
      'setMyName',
      'setMyDescription',
      'setMyDescription',
      'setMyDescription',
      'setMyShortDescription',
      'setMyShortDescription',
      'setMyShortDescription',
    ]);
    expect(calls[1]?.body).toEqual({
      menu_button: {
        type: 'web_app',
        text: 'Open Cometa',
        web_app: { url: 'https://euphoria.bot/' },
      },
    });
    expect(calls.slice(2, 5).map((call) => call.body.language_code))
      .toEqual([undefined, 'ru', 'en']);
    expect(calls[2]?.body.commands).toEqual(expect.arrayContaining([
      { command: 'privacy', description: 'What Cometa stores' },
    ]));
    expect(calls[3]?.body.commands).toEqual(expect.arrayContaining([
      { command: 'privacy', description: 'Какие данные хранит Cometa' },
    ]));
    expect(calls[4]?.body.commands).toEqual(expect.arrayContaining([
      { command: 'privacy', description: 'What Cometa stores' },
    ]));
  });

  it('serializes profile writes so Telegram never receives a startup burst', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async () => {
      callCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return jsonResponse(callCount === 1 ? { id: 1, is_bot: true } : true);
    });

    await setupBotProfile(client, new AbortController().signal);

    expect(callCount).toBe(14);
    expect(maxInFlight).toBe(1);
  });

  it('retries transient profile setup and honors Telegram retry_after', async () => {
    const calls: CapturedCall[] = [];
    const responses = [
      jsonResponse({ url: '', pending_update_count: 0 }),
      telegramErrorResponse(429, 2),
      jsonResponse({ id: 1, is_bot: true }),
      ...Array.from({ length: 13 }, () => jsonResponse(true)),
    ];
    const client = new BotApiClient(TOKEN, WEB_APP_URL, capturingFetch(responses, calls));
    const warnings: Array<{ event: string; context?: Readonly<Record<string, string | number | boolean>> }> = [];
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: (event, context) => warnings.push({ event, context }),
      error: () => undefined,
    };
    const sleeps: number[] = [];

    await setupBotForPolling(client, new AbortController().signal, logger, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const methods = calls.map((call) => new URL(call.url).pathname.split('/').at(-1));
    expect(methods.slice(0, 3)).toEqual(['getWebhookInfo', 'getMe', 'getMe']);
    expect(sleeps).toEqual([2_000]);
    expect(warnings).toEqual([{
      event: 'telegram_setup_retry',
      context: {
        step: 'profile.identity',
        attempt: 1,
        retryMs: 2_000,
        errorType: 'TelegramApiError',
        status: 429,
        errorCode: 429,
      },
    }]);
  });

  it('retries only the failed late profile action without replaying successful setup', async () => {
    const calls: CapturedCall[] = [];
    let failedEnglishShortDescription = false;
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async (input, init) => {
      const call = {
        url: input instanceof Request ? input.url : input.toString(),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      const method = new URL(call.url).pathname.split('/').at(-1);
      if (method === 'getWebhookInfo') {
        return jsonResponse({ url: '', pending_update_count: 0 });
      }
      if (method === 'getMe') return jsonResponse({ id: 1, is_bot: true });
      if (
        method === 'setMyShortDescription' &&
        call.body.language_code === 'en' &&
        !failedEnglishShortDescription
      ) {
        failedEnglishShortDescription = true;
        return telegramErrorResponse(500);
      }
      return jsonResponse(true);
    });
    const warnings: Array<{
      event: string;
      context?: Readonly<Record<string, string | number | boolean>>;
    }> = [];
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: (event, context) => warnings.push({ event, context }),
      error: () => undefined,
    };
    const sleeps: number[] = [];

    await setupBotForPolling(client, new AbortController().signal, logger, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const methods = calls.map((call) => new URL(call.url).pathname.split('/').at(-1));
    expect(methods.filter((method) => method === 'getWebhookInfo')).toHaveLength(1);
    expect(methods.filter((method) => method === 'getMe')).toHaveLength(1);
    expect(methods.filter((method) => method === 'setChatMenuButton')).toHaveLength(1);
    expect(methods.filter((method) => method === 'setMyCommands')).toHaveLength(3);
    expect(methods.filter((method) => method === 'setMyName')).toHaveLength(3);
    expect(methods.filter((method) => method === 'setMyDescription')).toHaveLength(3);
    expect(methods.filter((method) => method === 'setMyShortDescription')).toHaveLength(4);
    expect(sleeps).toEqual([1_000]);
    expect(warnings).toEqual([{
      event: 'telegram_setup_retry',
      context: {
        step: 'profile.short-description.en',
        attempt: 1,
        retryMs: 1_000,
        errorType: 'TelegramApiError',
        status: 500,
        errorCode: 500,
      },
    }]);
  });

  it('fails setup when the total startup deadline expires during a retry', async () => {
    const calls: CapturedCall[] = [];
    const deadline = new AbortController();
    const client = new BotApiClient(
      TOKEN,
      WEB_APP_URL,
      capturingFetch([
        jsonResponse({ url: '', pending_update_count: 0 }),
        telegramErrorResponse(429),
      ], calls),
    );
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    await expect(setupBotForPolling(
      client,
      new AbortController().signal,
      logger,
      {
        deadlineSignal: deadline.signal,
        sleep: async () => deadline.abort(),
      },
    )).rejects.toThrow('Telegram bot startup setup deadline exceeded');
    expect(calls.map((call) => new URL(call.url).pathname.split('/').at(-1)))
      .toEqual(['getWebhookInfo', 'getMe']);
  });

  it('sanitizes transport failures so the token and request URL cannot leak', async () => {
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async () => {
      throw new Error(`network failure at https://api.telegram.org/bot${TOKEN}/getMe`);
    });

    await expect(client.getMe()).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(TOKEN) && !message.includes('/bot123456:');
    });
  });

  it('preserves only safe Telegram error metadata including retry_after', async () => {
    const providerDescription = `flood wait near /bot${TOKEN}/getUpdates`;
    const client = new BotApiClient(TOKEN, WEB_APP_URL, async () =>
      new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: providerDescription,
        parameters: { retry_after: 37 },
      }), { status: 429, headers: { 'content-type': 'application/json' } }));

    await expect(client.getUpdates(undefined, 25)).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof TelegramApiError)) return false;
      return error.method === 'getUpdates' &&
        error.status === 429 &&
        error.errorCode === 429 &&
        error.retryAfter === 37 &&
        !error.message.includes(TOKEN) &&
        !error.message.includes(providerDescription);
    });
  });
});
