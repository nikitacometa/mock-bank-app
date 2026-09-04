import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramApiError } from './bot-api.js';
import { OnboardingEngine } from './onboarding.js';
import { PreferencesRepository } from './repository.js';
import type {
  BotTransport,
  InlineKeyboardMarkup,
  SendMessageInput,
  TelegramUpdate,
} from './telegram.js';

class FakeTransport implements BotTransport {
  readonly sent: SendMessageInput[] = [];
  readonly answers: { id: string; text?: string }[] = [];
  readonly menus: { chatId: string; locale: 'ru' | 'en' }[] = [];
  readonly events: ('send' | 'menu')[] = [];
  readonly sendErrors: unknown[] = [];
  readonly answerErrors: unknown[] = [];
  readonly menuErrors: unknown[] = [];
  readonly sendSignals: Array<AbortSignal | undefined> = [];
  readonly answerSignals: Array<AbortSignal | undefined> = [];
  readonly menuSignals: Array<AbortSignal | undefined> = [];
  sendFailuresRemaining = 0;
  menuFailuresRemaining = 0;

  async sendMessage(input: SendMessageInput, signal?: AbortSignal): Promise<void> {
    this.events.push('send');
    this.sendSignals.push(signal);
    const queuedError = this.sendErrors.shift();
    if (queuedError !== undefined) throw queuedError;
    if (this.sendFailuresRemaining > 0) {
      this.sendFailuresRemaining -= 1;
      throw new Error('send failed');
    }
    this.sent.push(input);
  }

  async answerCallbackQuery(
    id: string,
    text?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.answerSignals.push(signal);
    const queuedError = this.answerErrors.shift();
    if (queuedError !== undefined) throw queuedError;
    this.answers.push({ id, text });
  }

  async setUserMenuButton(
    chatId: string,
    locale: 'ru' | 'en',
    signal?: AbortSignal,
  ): Promise<void> {
    this.events.push('menu');
    this.menuSignals.push(signal);
    const queuedError = this.menuErrors.shift();
    if (queuedError !== undefined) throw queuedError;
    if (this.menuFailuresRemaining > 0) {
      this.menuFailuresRemaining -= 1;
      throw new Error('menu failed');
    }
    this.menus.push({ chatId, locale });
  }
}

const WEB_APP_URL = new URL('https://euphoria.bot/');
const USER = {
  id: '42',
  firstName: 'Ada',
  lastName: 'Lovelace',
  languageCode: 'en',
} as const;

function messageUpdate(
  updateId: number,
  text: string,
  type: 'private' | 'group' = 'private',
): TelegramUpdate {
  return {
    updateId,
    message: {
      messageId: updateId,
      chat: { id: type === 'private' ? '42' : '-100', type },
      from: USER,
      text,
    },
  };
}

function callbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    updateId,
    callbackQuery: {
      id: `callback-${updateId}`,
      from: USER,
      data,
      message: {
        messageId: updateId,
        chat: { id: '42', type: 'private' },
      },
    },
  };
}

function callbackData(markup: InlineKeyboardMarkup | undefined): string[] {
  return markup?.inline_keyboard.flat().flatMap((button) =>
    'callback_data' in button ? [button.callback_data] : [],
  ) ?? [];
}

function webAppUrls(markup: InlineKeyboardMarkup | undefined): string[] {
  return markup?.inline_keyboard.flat().flatMap((button) =>
    'web_app' in button ? [button.web_app.url] : [],
  ) ?? [];
}

describe('OnboardingEngine', () => {
  let repository: PreferencesRepository;
  let transport: FakeTransport;
  let engine: OnboardingEngine;
  let warnings: string[];
  let menuSleeps: number[];

  beforeEach(() => {
    repository = new PreferencesRepository(':memory:');
    transport = new FakeTransport();
    warnings = [];
    menuSleeps = [];
    engine = new OnboardingEngine(repository, transport, WEB_APP_URL, {
      warn: (event) => warnings.push(event),
    }, async (milliseconds) => {
      menuSleeps.push(milliseconds);
    });
  });

  afterEach(() => {
    repository.close();
  });

  it('starts a new English user with language choices and an immediate KZT launch', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start campaign'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada Lovelace',
      stage: 'language',
      revision: 1,
    });
    expect(transport.menus).toEqual([{ chatId: '42', locale: 'en' }]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('No real money or payments');
    expect(callbackData(transport.sent[0]?.replyMarkup)).toEqual(['lang:ru', 'lang:en']);
    expect(webAppUrls(transport.sent[0]?.replyMarkup)).toEqual(['https://euphoria.bot/']);
    expect(transport.sent[0]?.replyMarkup?.inline_keyboard[1]?.[0]?.text).toBe('Open now · KZT');
  });

  it('retries a failed first /start from the persisted language stage', async () => {
    transport.sendFailuresRemaining = 1;

    await expect(engine.handleUpdate(messageUpdate(1, '/start'))).rejects.toThrow('send failed');

    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      primaryCurrency: 'KZT',
      stage: 'language',
      revision: 1,
    });
    expect(transport.sent).toEqual([]);

    await engine.handleUpdate(messageUpdate(1, '/start'));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('Choose a language');
    expect(transport.sent[0]?.text).not.toContain('Welcome back');
    expect(callbackData(transport.sent[0]?.replyMarkup)).toEqual(['lang:ru', 'lang:en']);
  });

  it('sends /start before retrying a transient menu-button failure', async () => {
    transport.menuFailuresRemaining = 1;

    await expect(engine.handleUpdate(messageUpdate(1, '/start'))).resolves.toBeUndefined();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('Choose a language');
    expect(transport.events).toEqual(['send', 'menu', 'menu']);
    expect(transport.menus).toEqual([{ chatId: '42', locale: 'en' }]);
    expect(menuSleeps).toEqual([250]);
    expect(warnings).toEqual(['telegram_menu_button_retry']);
  });

  it('resumes /start at the persisted currency choice', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    repository.updateUser('42', { stage: 'currency' });
    transport.sent.length = 0;

    await engine.handleUpdate(messageUpdate(2, '/start'));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('<b>Primary currency</b>');
    expect(callbackData(transport.sent[0]?.replyMarkup)).toEqual([
      'currency:KZT',
      'currency:THB',
      'currency:VND',
      'currency:RUB',
      'currency:USD',
      'currency:EUR',
      'currency:IDR',
      'currency:GEL',
    ]);
    expect(webAppUrls(transport.sent[0]?.replyMarkup)).toEqual([]);
  });

  it('resumes /start at the persisted custom-name prompt', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    repository.updateUser('42', { stage: 'custom_name' });
    transport.sent.length = 0;

    await engine.handleUpdate(messageUpdate(2, '/start'));

    expect(transport.sent).toEqual([{
      chatId: '42',
      text: '<b>Your name in Cometa</b>\nSend it in one message: up to 48 characters, without control characters.',
      replyMarkup: undefined,
    }]);
  });

  it('runs Russian language selection through all eight currencies to a launch summary', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'lang:ru'));

    const currencyMessage = transport.sent.at(-1);
    expect(repository.getUser('42')).toMatchObject({ locale: 'ru', stage: 'currency', revision: 2 });
    expect(transport.menus.at(-1)).toEqual({ chatId: '42', locale: 'ru' });
    expect(callbackData(currencyMessage?.replyMarkup)).toEqual([
      'currency:KZT',
      'currency:THB',
      'currency:VND',
      'currency:RUB',
      'currency:USD',
      'currency:EUR',
      'currency:IDR',
      'currency:GEL',
    ]);

    await engine.handleUpdate(callbackUpdate(3, 'currency:GEL'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'ru',
      primaryCurrency: 'GEL',
      stage: 'complete',
      revision: 3,
    });
    expect(transport.sent.at(-1)?.text).toContain('Основная валюта: <b>GEL · ₾</b>');
    expect(webAppUrls(transport.sent.at(-1)?.replyMarkup)).toEqual(['https://euphoria.bot/']);
  });

  it('bumps revision for each distinct explicit same-value locale choice', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'lang:en'));
    await engine.handleUpdate(callbackUpdate(3, 'lang:en'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      stage: 'currency',
      revision: 3,
    });
  });

  it('bumps revision when bot reasserts equal preferences so Mini App accepts explicit intent', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));

    await engine.handleUpdate(callbackUpdate(2, 'setlang:en'));
    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada Lovelace',
      stage: 'complete',
      revision: 2,
    });

    await engine.handleUpdate(callbackUpdate(3, 'currency:KZT'));
    expect(repository.getUser('42')?.revision).toBe(3);

    await engine.handleUpdate(callbackUpdate(4, 'name:telegram'));
    expect(repository.getUser('42')?.revision).toBe(4);

    await engine.handleUpdate(callbackUpdate(5, 'name:custom'));
    expect(repository.getUser('42')).toMatchObject({ stage: 'custom_name', revision: 4 });

    await engine.handleUpdate(messageUpdate(6, 'Ada Lovelace'));
    expect(repository.getUser('42')).toMatchObject({
      displayName: 'Ada Lovelace',
      stage: 'complete',
      revision: 5,
    });
  });

  it('retries a failed equal-value preference confirmation with a monotonic revision', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    transport.sendFailuresRemaining = 1;

    await expect(engine.handleUpdate(callbackUpdate(2, 'setlang:en')))
      .rejects.toThrow('send failed');
    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      stage: 'complete',
      revision: 2,
    });

    await expect(engine.handleUpdate(callbackUpdate(2, 'setlang:en')))
      .resolves.toBeUndefined();
    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      stage: 'complete',
      revision: 3,
    });
    expect(transport.sent.at(-1)?.text).toContain('<b>Cometa is ready</b>');
  });

  it('accepts an optional custom name, rejects controls, and escapes HTML in replies', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'name:custom'));
    await engine.handleUpdate(messageUpdate(3, 'Ada\nLovelace'));

    expect(repository.getUser('42')).toMatchObject({ stage: 'custom_name', revision: 1 });
    expect(transport.sent.at(-1)?.text).toContain('cannot be saved');

    await engine.handleUpdate(messageUpdate(4, '  <Ada>\u00a0& Bob  '));

    expect(repository.getUser('42')).toMatchObject({
      displayName: '<Ada> & Bob',
      stage: 'complete',
      revision: 2,
    });
    const reply = transport.sent.at(-1)?.text ?? '';
    expect(reply).toContain('&lt;Ada&gt; &amp; Bob');
    expect(reply).not.toContain('<Ada>');
  });

  it('durably queues a failed custom-name summary without blocking update intake', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-onboarding-outbox-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const firstRepository = new PreferencesRepository(path);
      const firstTransport = new FakeTransport();
      const firstEngine = new OnboardingEngine(
        firstRepository,
        firstTransport,
        WEB_APP_URL,
        { warn: () => undefined },
        async () => undefined,
      );
      await firstEngine.handleUpdate(messageUpdate(1, '/start'));
      await firstEngine.handleUpdate(callbackUpdate(2, 'name:custom'));
      firstTransport.sendFailuresRemaining = 1;

      await expect(firstEngine.handleUpdate(messageUpdate(3, 'Grace')))
        .resolves.toBeUndefined();
      expect(firstRepository.getUser('42')).toMatchObject({
        displayName: 'Grace',
        stage: 'complete',
        revision: 2,
      });
      expect(firstRepository.getPendingReply(3)).not.toBeNull();
      firstRepository.close();

      const restartedRepository = new PreferencesRepository(path);
      const restartedTransport = new FakeTransport();
      const restartedEngine = new OnboardingEngine(
        restartedRepository,
        restartedTransport,
        WEB_APP_URL,
        { warn: () => undefined },
        async () => undefined,
      );
      try {
        await restartedEngine.flushPendingReplies();
        await restartedEngine.handleUpdate(messageUpdate(3, 'Grace'));
        await restartedEngine.handleUpdate(messageUpdate(3, 'Grace'));

        expect(restartedRepository.getUser('42')).toMatchObject({
          displayName: 'Grace',
          stage: 'complete',
          revision: 2,
        });
        expect(restartedRepository.getPendingReply(3)).toBeNull();
        expect(restartedTransport.sent).toHaveLength(1);
        expect(restartedTransport.sent[0]?.text).toContain('Name: <b>Grace</b>');
        expect(webAppUrls(restartedTransport.sent[0]?.replyMarkup))
          .toEqual(['https://euphoria.bot/']);
      } finally {
        restartedRepository.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes a permanently rejected 400 custom-name reply without retrying or reverting its intent', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'name:custom'));
    transport.sendErrors.push(new TelegramApiError('sendMessage', 400, 400));

    await expect(engine.handleUpdate(messageUpdate(3, 'Grace'))).resolves.toBeUndefined();

    expect(repository.getUser('42')).toMatchObject({
      displayName: 'Grace',
      stage: 'complete',
      revision: 2,
    });
    expect(repository.getPendingReply(3)).toBeNull();
    expect(warnings).toEqual(['telegram_pending_reply_rejected']);
    expect(transport.sent.at(-1)?.text).toContain('<b>Your name in Cometa</b>');
  });

  it.each([
    { label: 'auth-fatal 401', status: 401 },
    { label: 'auth-fatal 404', status: 404 },
  ])('fails on a $label custom-name reply while retaining it for service recovery', async ({ status }) => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'name:custom'));
    transport.sendErrors.push(new TelegramApiError('sendMessage', status, status));

    await expect(engine.handleUpdate(messageUpdate(3, 'Grace')))
      .rejects.toMatchObject({ name: 'TelegramApiError', errorCode: status });

    expect(repository.getUser('42')).toMatchObject({ displayName: 'Grace', revision: 2 });
    expect(repository.getPendingReply(3)).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it.each([
    { label: 'rate-limited 429', status: 429 },
    { label: 'transient 500', status: 500 },
  ])('defers a $label custom-name reply without failing update intake', async ({ status }) => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'name:custom'));
    transport.sendErrors.push(new TelegramApiError('sendMessage', status, status));

    await expect(engine.handleUpdate(messageUpdate(3, 'Grace')))
      .resolves.toBeUndefined();

    expect(repository.getUser('42')).toMatchObject({ displayName: 'Grace', revision: 2 });
    expect(repository.getPendingReply(3)).not.toBeNull();
    expect(warnings).toEqual(['telegram_pending_reply_retry']);
  });

  it('lets a later pending reply pass a transient row and backs off only the failed row', async () => {
    let nowMs = 10_000;
    const retryWarnings: Array<Readonly<Record<string, string | number>> | undefined> = [];
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
    transport.sendErrors.push(new TelegramApiError('sendMessage', 500, 500));
    const localEngine = new OnboardingEngine(
      repository,
      transport,
      WEB_APP_URL,
      {
        warn: (event, context) => {
          if (event === 'telegram_pending_reply_retry') retryWarnings.push(context);
        },
      },
      async () => undefined,
      () => nowMs,
    );

    await localEngine.flushPendingReplies();

    expect(transport.sent.map((message) => message.chatId)).toEqual(['43']);
    expect(repository.getPendingReply(700)).not.toBeNull();
    expect(repository.getPendingReply(701)).toBeNull();
    expect(retryWarnings).toEqual([expect.objectContaining({
      sourceUpdateId: 700,
      attempts: 1,
      retryMs: 1_000,
      status: 500,
    })]);

    await localEngine.flushPendingReplies();
    nowMs += 999;
    await localEngine.flushPendingReplies();
    expect(transport.events).toEqual(['send', 'send']);

    nowMs += 1;
    await localEngine.flushPendingReplies();
    expect(transport.sent.map((message) => message.chatId)).toEqual(['43', '42']);
    expect(repository.getPendingReply(700)).toBeNull();
  });

  it('honours retry_after for one pending reply without a hot retry loop', async () => {
    let nowMs = 20_000;
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.applyCustomNameIntent('42', '42', 700, 'Ada');
    transport.sendErrors.push(new TelegramApiError('sendMessage', 429, 429, 2));
    const localEngine = new OnboardingEngine(
      repository,
      transport,
      WEB_APP_URL,
      { warn: () => undefined },
      async () => undefined,
      () => nowMs,
    );

    await localEngine.flushPendingReplies();
    nowMs += 1_999;
    await localEngine.flushPendingReplies();
    expect(transport.events).toEqual(['send']);

    nowMs += 1;
    await localEngine.flushPendingReplies();
    expect(transport.events).toEqual(['send', 'send']);
    expect(repository.getPendingReply(700)).toBeNull();
  });

  it('restores the current Telegram name through an allowlisted callback', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    repository.updateUser('42', { displayName: 'Custom', stage: 'complete' });
    await engine.handleUpdate(callbackUpdate(2, 'name:telegram'));

    expect(repository.getUser('42')).toMatchObject({ displayName: 'Ada Lovelace', revision: 3 });
    expect(transport.sent.at(-1)?.text).toContain('Ada Lovelace');
  });

  it('shows a direct launch card to a returning user', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    repository.updateUser('42', { stage: 'complete' });
    transport.sent.length = 0;

    await engine.handleUpdate(messageUpdate(2, '/start'));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('Welcome back, Ada Lovelace');
    expect(callbackData(transport.sent[0]?.replyMarkup)).toContain('name:custom');
    expect(webAppUrls(transport.sent[0]?.replyMarkup)).toEqual(['https://euphoria.bot/']);
  });

  it('serves localized settings and help commands', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(messageUpdate(2, '/settings'));
    await engine.handleUpdate(messageUpdate(3, '/help'));

    expect(transport.sent.at(-2)?.text).toContain('<b>Cometa settings</b>');
    expect(callbackData(transport.sent.at(-2)?.replyMarkup)).toEqual([
      'settings:language',
      'settings:currency',
      'name:custom',
    ]);
    expect(transport.sent.at(-1)?.text).toContain('Rates are for reference');
  });

  it('serves an exact RU/EN privacy disclosure from the registered command', async () => {
    await engine.handleUpdate(messageUpdate(1, '/privacy@MyBankApp_Bot'));

    const english = transport.sent.at(-1)?.text ?? '';
    expect(english).toContain('<b>Cometa privacy</b>');
    expect(english).toContain('Telegram user and private chat IDs');
    expect(english).toContain('interface language, primary currency, optional display name');
    expect(english).toContain('onboarding stage, preference revision, and revision epoch');
    expect(english).toContain('processed update IDs');
    expect(english).toContain('a pending reply');
    expect(english).toContain('balances, accounts, cards, and the transaction ledger stay on your device');
    expect(english).toContain('does not process real payments or real money');

    await engine.handleUpdate(callbackUpdate(2, 'lang:ru'));
    await engine.handleUpdate(messageUpdate(3, '/privacy'));

    const russian = transport.sent.at(-1)?.text ?? '';
    expect(russian).toContain('<b>Конфиденциальность Cometa</b>');
    expect(russian).toContain('ID пользователя и приватного чата Telegram');
    expect(russian).toContain('язык интерфейса, основную валюту, необязательное имя');
    expect(russian).toContain('этап онбординга, revision настроек и revision epoch');
    expect(russian).toContain('ID обработанных updates');
    expect(russian).toContain('pending reply');
    expect(russian).toContain('Мок-балансы, счета, карты и журнал операций остаются на вашем устройстве');
    expect(russian).toContain('не проводит реальные платежи');
  });

  it('changes language from settings without forcing a new currency choice', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'settings:language'));

    expect(callbackData(transport.sent.at(-1)?.replyMarkup)).toEqual([
      'setlang:ru',
      'setlang:en',
    ]);
    expect(transport.sent.at(-1)?.replyMarkup?.inline_keyboard[1]?.[0]?.text)
      .toBe('Open Cometa · KZT');

    await engine.handleUpdate(callbackUpdate(3, 'setlang:ru'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'ru',
      primaryCurrency: 'KZT',
      stage: 'complete',
      revision: 2,
    });
    expect(transport.menus.at(-1)).toEqual({ chatId: '42', locale: 'ru' });
    expect(transport.sent.at(-1)?.text).toContain('<b>Cometa готова</b>');
  });

  it('keeps completed onboarding complete when an old language button is tapped', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    repository.updateUser('42', { primaryCurrency: 'GEL', stage: 'complete' });
    transport.sent.length = 0;

    await engine.handleUpdate(callbackUpdate(2, 'lang:ru'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'ru',
      primaryCurrency: 'GEL',
      stage: 'complete',
    });
    expect(transport.menus.at(-1)).toEqual({ chatId: '42', locale: 'ru' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('<b>Cometa готова</b>');
    expect(callbackData(transport.sent[0]?.replyMarkup)).not.toContain('currency:KZT');
    expect(webAppUrls(transport.sent[0]?.replyMarkup)).toEqual(['https://euphoria.bot/']);
  });

  it('keeps a pending custom-name edit when an old language button is tapped', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'lang:en'));
    await engine.handleUpdate(callbackUpdate(3, 'currency:GEL'));
    await engine.handleUpdate(callbackUpdate(4, 'name:custom'));
    transport.sent.length = 0;

    await engine.handleUpdate(callbackUpdate(5, 'lang:ru'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'ru',
      primaryCurrency: 'GEL',
      stage: 'custom_name',
    });
    expect(transport.sent).toEqual([{
      chatId: '42',
      text: '<b>Имя в Cometa</b>\nОтправьте имя одним сообщением: до 48 символов, без управляющих знаков.',
      replyMarkup: undefined,
    }]);

    await engine.handleUpdate(messageUpdate(6, 'Ник'));

    expect(repository.getUser('42')).toMatchObject({
      displayName: 'Ник',
      stage: 'complete',
    });
    expect(transport.sent.at(-1)?.text).toContain('Ник');
  });

  it('keeps a pending custom-name edit when an old settings-language button is tapped', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'lang:en'));
    await engine.handleUpdate(callbackUpdate(3, 'currency:GEL'));
    await engine.handleUpdate(callbackUpdate(4, 'name:custom'));
    transport.sent.length = 0;

    await engine.handleUpdate(callbackUpdate(5, 'setlang:ru'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'ru',
      primaryCurrency: 'GEL',
      stage: 'custom_name',
    });
    expect(transport.sent).toEqual([{
      chatId: '42',
      text: '<b>Имя в Cometa</b>\nОтправьте имя одним сообщением: до 48 символов, без управляющих знаков.',
      replyMarkup: undefined,
    }]);

    await engine.handleUpdate(messageUpdate(6, 'Ник'));

    expect(repository.getUser('42')).toMatchObject({
      displayName: 'Ник',
      locale: 'ru',
      stage: 'complete',
    });
  });

  it('keeps a pending custom-name edit when an old currency button is tapped', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    await engine.handleUpdate(callbackUpdate(2, 'lang:en'));
    await engine.handleUpdate(callbackUpdate(3, 'currency:GEL'));
    await engine.handleUpdate(callbackUpdate(4, 'name:custom'));
    transport.sent.length = 0;

    await engine.handleUpdate(callbackUpdate(5, 'currency:USD'));

    expect(repository.getUser('42')).toMatchObject({
      locale: 'en',
      primaryCurrency: 'USD',
      stage: 'custom_name',
    });
    expect(transport.sent).toEqual([{
      chatId: '42',
      text: '<b>Your name in Cometa</b>\nSend it in one message: up to 48 characters, without control characters.',
      replyMarkup: undefined,
    }]);

    await engine.handleUpdate(messageUpdate(6, 'Grace'));

    expect(repository.getUser('42')).toMatchObject({
      displayName: 'Grace',
      primaryCurrency: 'USD',
      stage: 'complete',
    });
  });

  it('sends a callback reply before retrying a transient menu-button failure', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    transport.events.length = 0;
    transport.sent.length = 0;
    transport.menuFailuresRemaining = 1;

    await expect(engine.handleUpdate(callbackUpdate(2, 'lang:ru'))).resolves.toBeUndefined();

    expect(repository.getUser('42')).toMatchObject({ locale: 'ru', stage: 'currency' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('<b>Основная валюта</b>');
    expect(transport.events).toEqual(['send', 'menu', 'menu']);
    expect(transport.menus.at(-1)).toEqual({ chatId: '42', locale: 'ru' });
    expect(menuSleeps).toEqual([250]);
    expect(warnings).toEqual(['telegram_menu_button_retry']);
  });

  it('threads the worker signal through replies, callback answers, and menu sync', async () => {
    const abort = new AbortController();

    await engine.handleUpdate(messageUpdate(1, '/start'), abort.signal);
    await engine.handleUpdate(callbackUpdate(2, 'lang:ru'), abort.signal);

    expect(transport.sendSignals).not.toContain(undefined);
    expect(transport.answerSignals).toEqual([abort.signal]);
    expect(transport.menuSignals).not.toContain(undefined);
    expect(transport.sendSignals.every((signal) => signal === abort.signal)).toBe(true);
    expect(transport.menuSignals.every((signal) => signal === abort.signal)).toBe(true);
  });

  it('cancels a menu retry sleep as soon as the worker aborts', async () => {
    const abort = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    let announceSleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      announceSleep = resolve;
    });
    transport.menuFailuresRemaining = 1;
    const localEngine = new OnboardingEngine(
      repository,
      transport,
      WEB_APP_URL,
      { warn: () => undefined },
      async (_milliseconds, signal) => {
        sleepSignal = signal;
        announceSleep?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );

    const handling = localEngine.handleUpdate(messageUpdate(1, '/start'), abort.signal);
    await sleepStarted;
    abort.abort();

    await expect(handling).rejects.toMatchObject({ name: 'AbortError' });
    expect(sleepSignal).toBe(abort.signal);
    expect(transport.events).toEqual(['send', 'menu']);
  });

  it('honours retry_after while retrying a localized menu button', async () => {
    transport.menuErrors.push(new TelegramApiError('setChatMenuButton', 429, 429, 2));

    await expect(engine.handleUpdate(messageUpdate(1, '/start'))).resolves.toBeUndefined();

    expect(menuSleeps).toEqual([2_000]);
    expect(transport.menus).toEqual([{ chatId: '42', locale: 'en' }]);
    expect(warnings).toEqual(['telegram_menu_button_retry']);
  });

  it('stops after bounded transient menu retries without failing the delivered bot flow', async () => {
    transport.menuFailuresRemaining = 3;

    await expect(engine.handleUpdate(messageUpdate(1, '/start'))).resolves.toBeUndefined();

    expect(transport.sent).toHaveLength(1);
    expect(transport.events).toEqual(['send', 'menu', 'menu', 'menu']);
    expect(transport.menus).toEqual([]);
    expect(menuSleeps).toEqual([250, 500]);
    expect(warnings).toEqual([
      'telegram_menu_button_retry',
      'telegram_menu_button_retry',
      'telegram_menu_button_failed',
    ]);
  });

  it('fails closed on a permanent menu-button rejection without retrying it', async () => {
    transport.menuErrors.push(new TelegramApiError('setChatMenuButton', 400, 400));

    await expect(engine.handleUpdate(messageUpdate(1, '/start')))
      .rejects.toMatchObject({ name: 'TelegramApiError', errorCode: 400 });

    expect(transport.sent).toHaveLength(1);
    expect(transport.events).toEqual(['send', 'menu']);
    expect(menuSleeps).toEqual([]);
    expect(warnings).toEqual(['telegram_menu_button_rejected']);
  });

  it('ignores group messages and does not create preferences', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start', 'group'));

    expect(repository.getUser('42')).toBeNull();
    expect(transport.sent).toEqual([]);
    expect(transport.menus).toEqual([]);
  });

  it('rejects callback data outside the exact allowlist without mutating state', async () => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    const before = repository.getUser('42');
    transport.sent.length = 0;

    await engine.handleUpdate(callbackUpdate(2, 'currency:BTC'));

    expect(repository.getUser('42')).toEqual(before);
    expect(transport.sent).toEqual([]);
    expect(transport.answers).toEqual([
      { id: 'callback-2', text: 'This button has expired' },
    ]);
  });

  it.each([401, 404])('propagates a fatal %i callback-answer failure', async (status) => {
    await engine.handleUpdate(messageUpdate(1, '/start'));
    transport.answerErrors.push(
      new TelegramApiError('answerCallbackQuery', status, status),
    );

    await expect(engine.handleUpdate(callbackUpdate(2, 'settings:currency')))
      .rejects.toMatchObject({ name: 'TelegramApiError', errorCode: status });

    expect(transport.sent).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
