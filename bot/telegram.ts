import type { TelegramUserIdentity } from './model.js';

export interface TelegramChat {
  readonly id: string;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramMessage {
  readonly messageId: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUserIdentity;
  readonly text?: string;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUserIdentity;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly updateId: number;
  readonly message?: TelegramMessage;
  readonly callbackQuery?: TelegramCallbackQuery;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function decimalId(value: unknown, allowNegative = false): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if ((!allowNegative && value <= 0) || value === 0) return null;
    return value.toString(10);
  }
  if (typeof value !== 'string') return null;
  const pattern = allowNegative ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/;
  return pattern.test(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseUser(value: unknown): TelegramUserIdentity | null {
  const source = record(value);
  if (source === null) return null;
  const id = decimalId(source.id);
  if (id === null) return null;
  return {
    id,
    firstName: optionalString(source.first_name),
    lastName: optionalString(source.last_name),
    username: optionalString(source.username),
    languageCode: optionalString(source.language_code),
  };
}

function parseChat(value: unknown): TelegramChat | null {
  const source = record(value);
  if (source === null) return null;
  const id = decimalId(source.id, true);
  const type = source.type;
  if (
    id === null ||
    (type !== 'private' && type !== 'group' && type !== 'supergroup' && type !== 'channel')
  ) {
    return null;
  }
  return { id, type };
}

function parseMessage(value: unknown): TelegramMessage | null {
  const source = record(value);
  if (source === null) return null;
  const messageId = safeInteger(source.message_id);
  const chat = parseChat(source.chat);
  if (messageId === null || messageId < 0 || chat === null) return null;
  const from = source.from === undefined ? undefined : parseUser(source.from) ?? undefined;
  const text = optionalString(source.text);
  return { messageId, chat, from, text };
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate {
  const source = record(value);
  const updateId = source === null ? null : safeInteger(source.update_id);
  if (source === null || updateId === null || updateId < 0) {
    throw new Error('Telegram returned an invalid update');
  }

  const message = source.message === undefined ? undefined : parseMessage(source.message) ?? undefined;
  let callbackQuery: TelegramCallbackQuery | undefined;
  if (source.callback_query !== undefined) {
    const callback = record(source.callback_query);
    const from = callback === null ? null : parseUser(callback.from);
    if (callback === null || typeof callback.id !== 'string' || from === null) {
      throw new Error('Telegram returned an invalid callback query');
    }
    callbackQuery = {
      id: callback.id,
      from,
      message: callback.message === undefined
        ? undefined
        : parseMessage(callback.message) ?? undefined,
      data: optionalString(callback.data),
    };
  }
  return { updateId, message, callbackQuery };
}

export type InlineKeyboardButton =
  | { readonly text: string; readonly callback_data: string }
  | { readonly text: string; readonly web_app: { readonly url: string } };

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface SendMessageInput {
  readonly chatId: string;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export interface BotTransport {
  sendMessage(input: SendMessageInput, signal?: AbortSignal): Promise<void>;
  answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  setUserMenuButton(
    chatId: string,
    locale: 'ru' | 'en',
    signal?: AbortSignal,
  ): Promise<void>;
}
