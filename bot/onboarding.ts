import { TelegramApiError } from './bot-api.js';
import { escapeHtml, normalizeDisplayName, telegramDisplayName } from './html.js';
import {
  BOT_CURRENCIES,
  isBotCurrency,
  isBotLocale,
  preferredLocale,
  type BotCurrency,
  type BotLocale,
  type StoredUser,
  type TelegramUserIdentity,
} from './model.js';
import { PreferencesRepository, type PendingReply } from './repository.js';
import type {
  BotTransport,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from './telegram.js';

const CURRENCY_SYMBOLS: Readonly<Record<BotCurrency, string>> = {
  KZT: '₸',
  THB: '฿',
  VND: '₫',
  RUB: '₽',
  USD: '$',
  EUR: '€',
  IDR: 'Rp',
  GEL: '₾',
};

const MENU_SYNC_ATTEMPTS = 3;
const MENU_SYNC_INITIAL_BACKOFF_MS = 250;
const MENU_SYNC_MAX_RETRY_AFTER_MS = 60_000;
const OUTBOX_INITIAL_BACKOFF_MS = 1_000;
const OUTBOX_MAX_BACKOFF_MS = 60_000;
const OUTBOX_MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;

type Clock = () => number;
type MenuSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

function menuDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableMenuError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return true;
  const code = error.errorCode ?? error.status;
  return code === 429 || code >= 500;
}

function isPermanentPendingReplyError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code >= 400 && code < 500 && code !== 401 && code !== 404 && code !== 429;
}

function isFatalProviderError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code === 401 || code === 404;
}

function pendingReplyRetryMs(error: unknown, attempts: number): number {
  const exponential = Math.min(
    OUTBOX_MAX_BACKOFF_MS,
    OUTBOX_INITIAL_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8),
  );
  const retryAfter = error instanceof TelegramApiError
    ? Math.min((error.retryAfter ?? 0) * 1_000, OUTBOX_MAX_RETRY_AFTER_MS)
    : 0;
  return Math.max(exponential, retryAfter);
}

type CallbackAction =
  | { readonly kind: 'language'; readonly locale: BotLocale }
  | { readonly kind: 'settingsLocale'; readonly locale: BotLocale }
  | { readonly kind: 'currency'; readonly currency: BotCurrency }
  | { readonly kind: 'customName' }
  | { readonly kind: 'telegramName' }
  | { readonly kind: 'settingsLanguage' }
  | { readonly kind: 'settingsCurrency' };

export interface BotLogger {
  warn(event: string, context?: Readonly<Record<string, string | number>>): void;
}

const silentLogger: BotLogger = { warn: () => undefined };

function callbackButton(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: data };
}

function webAppButton(text: string, webAppUrl: URL): InlineKeyboardButton {
  return { text, web_app: { url: webAppUrl.toString() } };
}

function launchLabel(locale: BotLocale): string {
  return locale === 'ru' ? 'Открыть Cometa' : 'Open Cometa';
}

function languageKeyboard(locale: BotLocale, webAppUrl: URL): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [callbackButton('Русский', 'lang:ru'), callbackButton('English', 'lang:en')],
      [webAppButton(
        locale === 'ru' ? 'Открыть сейчас · KZT' : 'Open now · KZT',
        webAppUrl,
      )],
    ],
  };
}

function settingsLanguageKeyboard(
  locale: BotLocale,
  currency: BotCurrency,
  webAppUrl: URL,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [callbackButton('Русский', 'setlang:ru'), callbackButton('English', 'setlang:en')],
      [webAppButton(`${launchLabel(locale)} · ${currency}`, webAppUrl)],
    ],
  };
}

function currencyKeyboard(): InlineKeyboardMarkup {
  const buttons = BOT_CURRENCIES.map((currency) =>
    callbackButton(`${currency} · ${CURRENCY_SYMBOLS[currency]}`, `currency:${currency}`),
  );
  return {
    inline_keyboard: [
      buttons.slice(0, 2),
      buttons.slice(2, 4),
      buttons.slice(4, 6),
      buttons.slice(6, 8),
    ],
  };
}

function summaryKeyboard(locale: BotLocale, webAppUrl: URL): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [webAppButton(launchLabel(locale), webAppUrl)],
      [
        callbackButton(
          locale === 'ru' ? 'Изменить имя' : 'Change name',
          'name:custom',
        ),
        callbackButton(
          locale === 'ru' ? 'Имя из Telegram' : 'Telegram name',
          'name:telegram',
        ),
      ],
    ],
  };
}

function settingsKeyboard(locale: BotLocale, webAppUrl: URL): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        callbackButton(locale === 'ru' ? 'Язык' : 'Language', 'settings:language'),
        callbackButton(locale === 'ru' ? 'Валюта' : 'Currency', 'settings:currency'),
      ],
      [callbackButton(locale === 'ru' ? 'Имя' : 'Name', 'name:custom')],
      [webAppButton(launchLabel(locale), webAppUrl)],
    ],
  };
}

function parseCallback(data: string | undefined): CallbackAction | null {
  if (data === undefined || data.length > 64) return null;
  if (data.startsWith('lang:')) {
    const locale = data.slice(5);
    return isBotLocale(locale) ? { kind: 'language', locale } : null;
  }
  if (data.startsWith('setlang:')) {
    const locale = data.slice(8);
    return isBotLocale(locale) ? { kind: 'settingsLocale', locale } : null;
  }
  if (data.startsWith('currency:')) {
    const currency = data.slice(9);
    return isBotCurrency(currency) ? { kind: 'currency', currency } : null;
  }
  if (data === 'name:custom') return { kind: 'customName' };
  if (data === 'name:telegram') return { kind: 'telegramName' };
  if (data === 'settings:language') return { kind: 'settingsLanguage' };
  if (data === 'settings:currency') return { kind: 'settingsCurrency' };
  return null;
}

function commandOf(
  text: string | undefined,
): 'start' | 'settings' | 'help' | 'privacy' | null {
  if (text === undefined) return null;
  const match = /^\/(start|settings|help|privacy)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text);
  return match?.[1] === 'start' ||
    match?.[1] === 'settings' ||
    match?.[1] === 'help' ||
    match?.[1] === 'privacy'
    ? match[1]
    : null;
}

function defaultName(user: TelegramUserIdentity, locale: BotLocale): string {
  return telegramDisplayName(
    user.firstName,
    user.lastName,
    locale === 'ru' ? 'Друг' : 'Friend',
  );
}

function languageText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Cometa</b>\nЛичный демо-банк в Telegram. Выберите язык или откройте приложение сейчас с KZT по умолчанию.\n\nЗдесь нет реальных денег и платежей.'
    : '<b>Cometa</b>\nYour personal demo bank in Telegram. Choose a language, or open the app now with KZT as the default.\n\nNo real money or payments are involved.';
}

function currencyText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Основная валюта</b>\nВ ней Cometa покажет общую стоимость всех счетов. Сами счета останутся в своих валютах.'
    : '<b>Primary currency</b>\nCometa will use it for the total value of all accounts. Each account keeps its own currency.';
}

function settingsLanguageText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Язык интерфейса</b>\nВыберите язык для бота и приложения.'
    : '<b>Interface language</b>\nChoose the language for the bot and the app.';
}

function summaryText(user: StoredUser): string {
  const name = escapeHtml(user.displayName);
  const currency = `${user.primaryCurrency} · ${CURRENCY_SYMBOLS[user.primaryCurrency]}`;
  return user.locale === 'ru'
    ? `<b>Cometa готова</b>\nИмя: <b>${name}</b>\nОсновная валюта: <b>${currency}</b>\n\nЭто демо-банк: реальные деньги и платежи не используются.`
    : `<b>Cometa is ready</b>\nName: <b>${name}</b>\nPrimary currency: <b>${currency}</b>\n\nThis is a demo bank. It does not use real money or payments.`;
}

function launchText(user: StoredUser): string {
  const name = escapeHtml(user.displayName);
  return user.locale === 'ru'
    ? `<b>С возвращением, ${name}</b>\nВаши демо-счета готовы. Общая стоимость показана в ${user.primaryCurrency}.\n\nРеальные деньги и платежи не используются.`
    : `<b>Welcome back, ${name}</b>\nYour demo accounts are ready. The portfolio total is shown in ${user.primaryCurrency}.\n\nNo real money or payments are involved.`;
}

function settingsText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Настройки Cometa</b>\nМожно поменять язык, основную валюту или имя в приложении.'
    : '<b>Cometa settings</b>\nChange the interface language, primary currency, or name shown in the app.';
}

function helpText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Как работает Cometa</b>\n/start — открыть демо-банк\n/settings — язык, валюта и имя\n/help — эта подсказка\n/privacy — какие данные хранит Cometa\n\nКурсы справочные. Реальные деньги и платежи не используются.'
    : '<b>How Cometa works</b>\n/start — open the demo bank\n/settings — language, currency, and name\n/help — show this guide\n/privacy — what Cometa stores\n\nRates are for reference. No real money or payments are involved.';
}

function privacyText(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Конфиденциальность Cometa</b>\nСервер хранит ID пользователя и приватного чата Telegram, язык интерфейса, основную валюту, необязательное имя, этап онбординга, revision настроек и revision epoch. Также хранятся ID обработанных updates и pending reply — до его доставки или окончательного отклонения.\n\nМок-балансы, счета, карты и журнал операций остаются на вашем устройстве. Cometa не проводит реальные платежи и не работает с реальными деньгами.'
    : '<b>Cometa privacy</b>\nThe server stores your Telegram user and private chat IDs, interface language, primary currency, optional display name, onboarding stage, preference revision, and revision epoch. It also keeps processed update IDs and a pending reply until it is delivered or permanently rejected.\n\nMock balances, accounts, cards, and the transaction ledger stay on your device. Cometa does not process real payments or real money.';
}

function customNamePrompt(locale: BotLocale): string {
  return locale === 'ru'
    ? '<b>Имя в Cometa</b>\nОтправьте имя одним сообщением: до 48 символов, без управляющих знаков.'
    : '<b>Your name in Cometa</b>\nSend it in one message: up to 48 characters, without control characters.';
}

function invalidNameText(locale: BotLocale): string {
  return locale === 'ru'
    ? 'Не получилось сохранить имя. Нужны 1–48 обычных символов.'
    : 'That name cannot be saved. Use 1–48 regular characters.';
}

export class OnboardingEngine {
  readonly #repository: PreferencesRepository;
  readonly #transport: BotTransport;
  readonly #webAppUrl: URL;
  readonly #logger: BotLogger;
  readonly #menuSleep: MenuSleep;
  readonly #clock: Clock;
  readonly #pendingReplyRetries = new Map<
    number,
    { readonly attempts: number; readonly nextAttemptAt: number }
  >();

  constructor(
    repository: PreferencesRepository,
    transport: BotTransport,
    webAppUrl: URL,
    logger: BotLogger = silentLogger,
    menuSleep: MenuSleep = menuDelay,
    clock: Clock = Date.now,
  ) {
    this.#repository = repository;
    this.#transport = transport;
    this.#webAppUrl = webAppUrl;
    this.#logger = logger;
    this.#menuSleep = menuSleep;
    this.#clock = clock;
  }

  async handleUpdate(update: TelegramUpdate, signal?: AbortSignal): Promise<void> {
    const pending = this.#repository.getPendingReply(update.updateId);
    if (pending !== null) {
      await this.#attemptPendingReply(pending, signal);
      return;
    }
    if (update.message !== undefined) {
      await this.#handleMessage(update.message, update.updateId, signal);
    }
    if (update.callbackQuery !== undefined) {
      await this.#handleCallback(update.callbackQuery, signal);
    }
  }

  async flushPendingReplies(signal?: AbortSignal): Promise<void> {
    // Telegram applies per-bot send limits, so outbox delivery is intentionally serialized.
    for (const pending of this.#repository.listPendingReplies()) {
      signal?.throwIfAborted();
      await this.#attemptPendingReply(pending, signal);
    }
  }

  async #handleMessage(
    message: TelegramMessage,
    updateId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (message.chat.type !== 'private' || message.from === undefined) return;
    const initialLocale = preferredLocale(message.from.languageCode);
    const ensured = this.#repository.ensureUser({
      telegramUserId: message.from.id,
      locale: initialLocale,
      primaryCurrency: 'KZT',
      displayName: defaultName(message.from, initialLocale),
    });
    const command = commandOf(message.text);
    const shouldSyncMenu = ensured.created || command === 'start';

    if (command === 'start') {
      await this.#sendStart(message.chat.id, ensured.user, signal);
      if (shouldSyncMenu) {
        await this.#syncMenuButton(message.from.id, ensured.user.locale, signal);
      }
      return;
    }
    if (command === 'settings') {
      await this.#send(
        message.chat.id,
        settingsText(ensured.user.locale),
        settingsKeyboard(ensured.user.locale, this.#webAppUrl),
        signal,
      );
      if (shouldSyncMenu) {
        await this.#syncMenuButton(message.from.id, ensured.user.locale, signal);
      }
      return;
    }
    if (command === 'help') {
      await this.#send(
        message.chat.id,
        helpText(ensured.user.locale),
        { inline_keyboard: [[webAppButton(launchLabel(ensured.user.locale), this.#webAppUrl)]] },
        signal,
      );
      if (shouldSyncMenu) {
        await this.#syncMenuButton(message.from.id, ensured.user.locale, signal);
      }
      return;
    }
    if (command === 'privacy') {
      await this.#send(
        message.chat.id,
        privacyText(ensured.user.locale),
        { inline_keyboard: [[webAppButton(launchLabel(ensured.user.locale), this.#webAppUrl)]] },
        signal,
      );
      if (shouldSyncMenu) {
        await this.#syncMenuButton(message.from.id, ensured.user.locale, signal);
      }
      return;
    }
    if (ensured.user.stage === 'custom_name' && message.text !== undefined) {
      const displayName = normalizeDisplayName(message.text);
      if (displayName === null) {
        await this.#send(message.chat.id, invalidNameText(ensured.user.locale), undefined, signal);
        return;
      }
      this.#repository.applyCustomNameIntent(
        message.from.id,
        message.chat.id,
        updateId,
        displayName,
      );
      const pending = this.#repository.getPendingReply(updateId);
      if (pending === null) throw new Error('Custom name reply was not queued');
      await this.#attemptPendingReply(pending, signal);
      return;
    }
    if (shouldSyncMenu) {
      await this.#syncMenuButton(message.from.id, ensured.user.locale, signal);
    }
  }

  async #handleCallback(
    callback: TelegramCallbackQuery,
    signal?: AbortSignal,
  ): Promise<void> {
    if (callback.message?.chat.type !== 'private') return;
    const initialLocale = preferredLocale(callback.from.languageCode);
    const ensured = this.#repository.ensureUser({
      telegramUserId: callback.from.id,
      locale: initialLocale,
      primaryCurrency: 'KZT',
      displayName: defaultName(callback.from, initialLocale),
    });
    const action = parseCallback(callback.data);
    await this.#answerCallback(
      callback.id,
      action === null
        ? ensured.user.locale === 'ru' ? 'Кнопка устарела' : 'This button has expired'
        : undefined,
      signal,
    );
    if (action === null) {
      if (ensured.created) {
        await this.#syncMenuButton(callback.from.id, ensured.user.locale, signal);
      }
      return;
    }

    const chatId = callback.message.chat.id;
    let menuLocale: BotLocale | null = ensured.created ? ensured.user.locale : null;
    switch (action.kind) {
      case 'language': {
        const alreadyComplete = ensured.user.stage === 'complete';
        const isChangingName = ensured.user.stage === 'custom_name';
        const updated = this.#repository.applyPreferenceIntent(callback.from.id, {
          locale: action.locale,
          stage: alreadyComplete || isChangingName ? ensured.user.stage : 'currency',
        });
        menuLocale = updated.locale;
        if (isChangingName) {
          await this.#send(chatId, customNamePrompt(updated.locale), undefined, signal);
        } else if (alreadyComplete) {
          await this.#send(
            chatId,
            summaryText(updated),
            summaryKeyboard(updated.locale, this.#webAppUrl),
            signal,
          );
        } else {
          await this.#send(chatId, currencyText(updated.locale), currencyKeyboard(), signal);
        }
        break;
      }
      case 'settingsLocale': {
        const isChangingName = ensured.user.stage === 'custom_name';
        const updated = this.#repository.applyPreferenceIntent(callback.from.id, {
          locale: action.locale,
          stage: isChangingName ? 'custom_name' : 'complete',
        });
        menuLocale = updated.locale;
        if (isChangingName) {
          await this.#send(chatId, customNamePrompt(updated.locale), undefined, signal);
        } else {
          await this.#send(
            chatId,
            summaryText(updated),
            summaryKeyboard(updated.locale, this.#webAppUrl),
            signal,
          );
        }
        break;
      }
      case 'currency': {
        const isChangingName = ensured.user.stage === 'custom_name';
        const updated = this.#repository.applyPreferenceIntent(callback.from.id, {
          primaryCurrency: action.currency,
          stage: isChangingName ? 'custom_name' : 'complete',
        });
        if (isChangingName) {
          await this.#send(chatId, customNamePrompt(updated.locale), undefined, signal);
        } else {
          await this.#send(
            chatId,
            summaryText(updated),
            summaryKeyboard(updated.locale, this.#webAppUrl),
            signal,
          );
        }
        break;
      }
      case 'customName': {
        const updated = this.#repository.updateUser(callback.from.id, { stage: 'custom_name' });
        await this.#send(chatId, customNamePrompt(updated.locale), undefined, signal);
        break;
      }
      case 'telegramName': {
        const updated = this.#repository.applyPreferenceIntent(callback.from.id, {
          displayName: defaultName(callback.from, ensured.user.locale),
          stage: 'complete',
        });
        await this.#send(
          chatId,
          summaryText(updated),
          summaryKeyboard(updated.locale, this.#webAppUrl),
          signal,
        );
        break;
      }
      case 'settingsLanguage': {
        await this.#send(
          chatId,
          settingsLanguageText(ensured.user.locale),
          settingsLanguageKeyboard(
            ensured.user.locale,
            ensured.user.primaryCurrency,
            this.#webAppUrl,
          ),
          signal,
        );
        break;
      }
      case 'settingsCurrency': {
        await this.#send(
          chatId,
          currencyText(ensured.user.locale),
          currencyKeyboard(),
          signal,
        );
        break;
      }
    }
    if (menuLocale !== null) {
      await this.#syncMenuButton(callback.from.id, menuLocale, signal);
    }
  }

  async #send(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.#transport.sendMessage({ chatId, text, replyMarkup }, signal);
  }

  async #sendStart(
    chatId: string,
    user: StoredUser,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (user.stage) {
      case 'language':
        await this.#send(
          chatId,
          languageText(user.locale),
          languageKeyboard(user.locale, this.#webAppUrl),
          signal,
        );
        return;
      case 'currency':
        await this.#send(chatId, currencyText(user.locale), currencyKeyboard(), signal);
        return;
      case 'custom_name':
        await this.#send(chatId, customNamePrompt(user.locale), undefined, signal);
        return;
      case 'complete':
        await this.#send(
          chatId,
          launchText(user),
          summaryKeyboard(user.locale, this.#webAppUrl),
          signal,
        );
    }
  }

  async #attemptPendingReply(
    pending: PendingReply,
    signal?: AbortSignal,
  ): Promise<void> {
    const retry = this.#pendingReplyRetries.get(pending.sourceUpdateId);
    if (retry !== undefined && this.#clock() < retry.nextAttemptAt) return;
    try {
      await this.#deliverPendingReply(pending, signal);
      this.#pendingReplyRetries.delete(pending.sourceUpdateId);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (isFatalProviderError(error)) throw error;
      const attempts = Math.min((retry?.attempts ?? 0) + 1, 31);
      const retryMs = pendingReplyRetryMs(error, attempts);
      this.#pendingReplyRetries.set(pending.sourceUpdateId, {
        attempts,
        nextAttemptAt: Math.min(Number.MAX_SAFE_INTEGER, this.#clock() + retryMs),
      });
      this.#logger.warn('telegram_pending_reply_retry', {
        sourceUpdateId: pending.sourceUpdateId,
        attempts,
        retryMs,
        ...(error instanceof TelegramApiError
          ? {
              status: error.status,
              ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
            }
          : { errorType: error instanceof Error ? error.name : 'unknown' }),
      });
    }
  }

  async #deliverPendingReply(
    pending: PendingReply,
    signal?: AbortSignal,
  ): Promise<void> {
    const user = this.#repository.getUser(pending.telegramUserId);
    if (user === null) throw new Error('Pending reply user not found');
    try {
      await this.#send(
        pending.chatId,
        summaryText(user),
        summaryKeyboard(user.locale, this.#webAppUrl),
        signal,
      );
    } catch (error: unknown) {
      if (!isPermanentPendingReplyError(error)) throw error;
      if (!this.#repository.completePendingReply(pending.sourceUpdateId)) {
        throw new Error('Pending reply disappeared before rejection cleanup', { cause: error });
      }
      this.#logger.warn('telegram_pending_reply_rejected');
      return;
    }
    if (!this.#repository.completePendingReply(pending.sourceUpdateId)) {
      throw new Error('Pending reply disappeared before completion');
    }
  }

  async #answerCallback(
    callbackQueryId: string,
    text?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      signal?.throwIfAborted();
      await this.#transport.answerCallbackQuery(callbackQueryId, text, signal);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (isFatalProviderError(error)) throw error;
      this.#logger.warn('telegram_callback_answer_failed');
    }
  }

  async #syncMenuButton(
    userId: string,
    locale: BotLocale,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MENU_SYNC_ATTEMPTS; attempt += 1) {
      try {
        signal?.throwIfAborted();
        await this.#transport.setUserMenuButton(userId, locale, signal);
        return;
      } catch (error: unknown) {
        signal?.throwIfAborted();
        if (!isRetryableMenuError(error)) {
          this.#logger.warn('telegram_menu_button_rejected');
          throw error;
        }
        if (attempt === MENU_SYNC_ATTEMPTS) {
          this.#logger.warn('telegram_menu_button_failed');
          return;
        }
        const exponential = MENU_SYNC_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        const retryAfter = error instanceof TelegramApiError
          ? Math.min((error.retryAfter ?? 0) * 1_000, MENU_SYNC_MAX_RETRY_AFTER_MS)
          : 0;
        this.#logger.warn('telegram_menu_button_retry');
        await this.#menuSleep(Math.max(exponential, retryAfter), signal);
        signal?.throwIfAborted();
      }
    }
  }
}
