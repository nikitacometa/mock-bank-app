import {
  parseTelegramUpdate,
  type BotTransport,
  type InlineKeyboardMarkup,
  type SendMessageInput,
  type TelegramUpdate,
} from './telegram.js';

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const POLL_REQUEST_TIMEOUT_MS = 35_000;

type BotApiMethod =
  | 'answerCallbackQuery'
  | 'deleteWebhook'
  | 'getMe'
  | 'getUpdates'
  | 'getWebhookInfo'
  | 'sendMessage'
  | 'setChatMenuButton'
  | 'setMyCommands'
  | 'setMyDescription'
  | 'setMyName'
  | 'setMyShortDescription';

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface BotApiEnvelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly errorCode?: number;
  readonly retryAfter?: number;
}

export interface WebhookInfo {
  readonly url: string;
  readonly pendingUpdateCount: number;
}

export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

/** Sanitized provider failure: never retains Telegram's token-bearing URL or description. */
export class TelegramApiError extends Error {
  readonly method: BotApiMethod;
  readonly status: number;
  readonly errorCode?: number;
  readonly retryAfter?: number;

  constructor(
    method: BotApiMethod,
    status: number,
    errorCode?: number,
    retryAfter?: number,
  ) {
    super(`Telegram API rejected request: ${method} (${status}/${errorCode ?? 'unknown'})`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

function parseEnvelope(value: unknown): BotApiEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.ok !== 'boolean') return null;
  const errorCode = typeof source.error_code === 'number' &&
    Number.isSafeInteger(source.error_code) && source.error_code > 0
    ? source.error_code
    : undefined;
  const parameters = typeof source.parameters === 'object' &&
    source.parameters !== null && !Array.isArray(source.parameters)
    ? source.parameters as Record<string, unknown>
    : null;
  const retryAfter = typeof parameters?.retry_after === 'number' &&
    Number.isSafeInteger(parameters.retry_after) && parameters.retry_after > 0
    ? parameters.retry_after
    : undefined;
  return { ok: source.ok, result: source.result, errorCode, retryAfter };
}

function parseWebhookInfo(value: unknown): WebhookInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Telegram returned invalid webhook info');
  }
  const source = value as Record<string, unknown>;
  if (
    typeof source.url !== 'string' ||
    typeof source.pending_update_count !== 'number' ||
    !Number.isSafeInteger(source.pending_update_count) ||
    source.pending_update_count < 0
  ) {
    throw new Error('Telegram returned invalid webhook info');
  }
  return { url: source.url, pendingUpdateCount: source.pending_update_count };
}

export class BotApiClient implements BotTransport {
  readonly #botToken: string;
  readonly #webAppUrl: string;
  readonly #fetch: FetchImplementation;

  constructor(botToken: string, webAppUrl: URL, fetchImplementation: FetchImplementation = fetch) {
    this.#botToken = botToken;
    this.#webAppUrl = webAppUrl.toString();
    this.#fetch = fetchImplementation;
  }

  async getWebhookInfo(signal?: AbortSignal): Promise<WebhookInfo> {
    return parseWebhookInfo(await this.#call('getWebhookInfo', {}, signal));
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    const result = await this.#call('deleteWebhook', { drop_pending_updates: false }, signal);
    if (result !== true) throw new Error('Telegram did not confirm webhook deletion');
  }

  async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<readonly TelegramUpdate[]> {
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new TypeError('Polling timeout must be a positive integer');
    }
    const result = await this.#call(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
        limit: 50,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
      POLL_REQUEST_TIMEOUT_MS,
    );
    if (!Array.isArray(result)) throw new Error('Telegram returned invalid updates');
    return result.map(parseTelegramUpdate);
  }

  async sendMessage(input: SendMessageInput, signal?: AbortSignal): Promise<void> {
    await this.#call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup }),
    }, signal);
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    }, signal);
  }

  async setUserMenuButton(
    chatId: string,
    locale: 'ru' | 'en',
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[1-9]\d*$/.test(chatId)) throw new TypeError('Invalid private chat ID');
    const numericChatId = Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) throw new TypeError('Invalid private chat ID');
    await this.#setChatMenuButton(
      numericChatId,
      locale === 'ru' ? 'Открыть Cometa' : 'Open Cometa',
      signal,
    );
  }

  async setDefaultMenuButton(signal?: AbortSignal): Promise<void> {
    await this.#setChatMenuButton(undefined, 'Open Cometa', signal);
  }

  async setMyCommands(
    commands: readonly BotCommand[],
    languageCode?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call('setMyCommands', {
      commands,
      ...(languageCode === undefined ? {} : { language_code: languageCode }),
    }, signal);
  }

  async setMyName(name: string, languageCode?: string, signal?: AbortSignal): Promise<void> {
    await this.#call('setMyName', {
      name,
      ...(languageCode === undefined ? {} : { language_code: languageCode }),
    }, signal);
  }

  async setMyDescription(
    description: string,
    languageCode?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call('setMyDescription', {
      description,
      ...(languageCode === undefined ? {} : { language_code: languageCode }),
    }, signal);
  }

  async setMyShortDescription(
    shortDescription: string,
    languageCode?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call('setMyShortDescription', {
      short_description: shortDescription,
      ...(languageCode === undefined ? {} : { language_code: languageCode }),
    }, signal);
  }

  async getMe(signal?: AbortSignal): Promise<void> {
    const result = await this.#call('getMe', {}, signal);
    if (typeof result !== 'object' || result === null) {
      throw new Error('Telegram returned invalid bot identity');
    }
  }

  async #setChatMenuButton(
    chatId: number | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call('setChatMenuButton', {
      ...(chatId === undefined ? {} : { chat_id: chatId }),
      menu_button: {
        type: 'web_app',
        text,
        web_app: { url: this.#webAppUrl },
      },
    }, signal);
  }

  async #call(
    method: BotApiMethod,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(
        `${TELEGRAM_API_ORIGIN}/bot${this.#botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: requestSignal,
        },
      );
    } catch {
      signal?.throwIfAborted();
      throw new Error(`Telegram API request failed: ${method}`);
    }

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new Error(`Telegram API returned invalid JSON: ${method}`);
    }
    const envelope = parseEnvelope(payload);
    if (envelope === null) {
      throw new TelegramApiError(method, response.status);
    }
    if (!response.ok || !envelope.ok) {
      throw new TelegramApiError(
        method,
        response.status,
        envelope.errorCode,
        envelope.retryAfter,
      );
    }
    return envelope.result;
  }
}

export function webAppKeyboard(text: string, webAppUrl: URL): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text, web_app: { url: webAppUrl.toString() } }]] };
}
