import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { balanceOf } from '../src/domain/ledger.js';
import { buildSeed } from '../src/domain/seed.js';
import type { BankState, Currency } from '../src/domain/types.js';
import {
  bankDomainAdapter,
  snapshotRecurringWarningContexts,
} from './bank-domain.js';
import { TelegramApiError } from './bot-api.js';
import { BankAuthorityService } from './bank-service.js';
import type { BotLocale, TelegramUserIdentity } from './model.js';
import { OnboardingEngine } from './onboarding.js';
import {
  InMemoryBankRequestLimiter,
  type BankRequestLimiter,
} from './rate-limit.js';
import { PreferencesRepository } from './repository.js';
import type {
  BotTransport,
  InlineKeyboardMarkup,
  SendMessageInput,
  TelegramUpdate,
} from './telegram.js';

const WEB_APP_URL = new URL('https://euphoria.bot/');
const DEFAULT_NOW = '2026-09-05T12:00:00.000Z';

class FakeTransport implements BotTransport {
  readonly sent: SendMessageInput[] = [];
  readonly answers: Array<{ id: string; text?: string }> = [];
  readonly menus: Array<{ chatId: string; locale: BotLocale }> = [];
  readonly sendErrors: unknown[] = [];

  async sendMessage(input: SendMessageInput): Promise<void> {
    const error = this.sendErrors.shift();
    if (error !== undefined) throw error;
    this.sent.push(input);
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }

  async setUserMenuButton(chatId: string, locale: BotLocale): Promise<void> {
    this.menus.push({ chatId, locale });
  }
}

interface Harness {
  readonly repository: PreferencesRepository;
  readonly service: BankAuthorityService<BankState, import('../src/domain/bankCommands.js').BankCommand>;
  readonly transport: FakeTransport;
  readonly engine: OnboardingEngine;
  readonly now: { value: string };
}

const repositories = new Set<PreferencesRepository>();

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.clear();
});

function user(id = '42', locale: BotLocale = 'en'): TelegramUserIdentity {
  return {
    id,
    firstName: id === '42' ? 'Ada' : 'Grace',
    lastName: id === '42' ? 'Lovelace' : 'Hopper',
    languageCode: locale,
  };
}

function messageUpdate(
  updateId: number,
  text: string,
  identity: TelegramUserIdentity = user(),
): TelegramUpdate {
  return {
    updateId,
    message: {
      messageId: updateId,
      chat: { id: identity.id, type: 'private' },
      from: identity,
      text,
    },
  };
}

function callbackUpdate(
  updateId: number,
  data: string,
  identity: TelegramUserIdentity = user(),
): TelegramUpdate {
  return {
    updateId,
    callbackQuery: {
      id: `callback-${identity.id}-${updateId}`,
      from: identity,
      data,
      message: {
        messageId: updateId,
        chat: { id: identity.id, type: 'private' },
      },
    },
  };
}

function callbackButtons(markup: InlineKeyboardMarkup | undefined): Array<{
  readonly text: string;
  readonly data: string;
}> {
  return markup?.inline_keyboard.flat().flatMap((candidate) =>
    'callback_data' in candidate
      ? [{ text: candidate.text, data: candidate.callback_data }]
      : [],
  ) ?? [];
}

function lastButtons(harness: Harness): Array<{ readonly text: string; readonly data: string }> {
  return callbackButtons(harness.transport.sent.at(-1)?.replyMarkup);
}

function actionButton(
  harness: Harness,
  action: string,
  argument?: string,
): string {
  const suffix = argument === undefined ? `:${action}` : `:${action}:${argument}`;
  const result = lastButtons(harness).find((candidate) => candidate.data.endsWith(suffix));
  if (result === undefined) {
    throw new Error(`Missing callback action ${action}${argument === undefined ? '' : `:${argument}`}`);
  }
  return result.data;
}

function textButton(harness: Harness, text: string): string {
  const result = lastButtons(harness).find((candidate) => candidate.text.includes(text));
  if (result === undefined) throw new Error(`Missing callback button containing ${text}`);
  return result.data;
}

function createHarness(
  path = ':memory:',
  now: { value: string } = { value: DEFAULT_NOW },
  bankRequestLimiter?: BankRequestLimiter,
): Harness {
  const repository = new PreferencesRepository(path, () => new Date(now.value));
  repositories.add(repository);
  const service = new BankAuthorityService(repository, bankDomainAdapter, () => new Date(now.value));
  const transport = new FakeTransport();
  const engine = new OnboardingEngine(
    repository,
    transport,
    WEB_APP_URL,
    { warn: () => undefined },
    async () => undefined,
    () => Date.parse(now.value),
    service,
    bankRequestLimiter,
  );
  return { repository, service, transport, engine, now };
}

function activateUser(
  harness: Harness,
  identity: TelegramUserIdentity = user(),
  demoBaseCurrency: Currency = 'KZT',
): BankState {
  const locale = identity.languageCode === 'ru' ? 'ru' : 'en';
  harness.repository.ensureUser({
    telegramUserId: identity.id,
    locale,
    primaryCurrency: demoBaseCurrency,
    displayName: `${identity.firstName ?? ''} ${identity.lastName ?? ''}`.trim(),
  });
  harness.repository.updateUser(identity.id, { stage: 'complete' });
  harness.repository.setLedgerMode('server');
  const state: BankState = {
    ...buildSeed(harness.now.value, demoBaseCurrency),
    profile: {
      displayName: identity.firstName ?? 'Friend',
      telegramId: identity.id,
    },
  };
  const fill = identity.id === '42' ? 'a' : identity.id === '43' ? 'b' : 'c';
  harness.service.importState({
    telegramUserId: identity.id,
    importId: fill.repeat(32),
    stateVersion: 5,
    rawState: state,
  });
  return state;
}

function canonicalState(harness: Harness, telegramUserId = '42'): BankState {
  const payload = harness.service.materialize(telegramUserId);
  return payload.state as BankState;
}

async function advanceToAmount(
  harness: Harness,
  direction: 'expense' | 'income',
  updateBase: number,
  identity: TelegramUserIdentity = user(),
): Promise<number> {
  await harness.engine.handleUpdate(messageUpdate(updateBase, '/add', identity));
  await harness.engine.handleUpdate(callbackUpdate(
    updateBase + 1,
    actionButton(harness, 'td', direction === 'expense' ? 'e' : 'i'),
    identity,
  ));
  await harness.engine.handleUpdate(callbackUpdate(
    updateBase + 2,
    actionButton(harness, 'ac', '0'),
    identity,
  ));
  return updateBase + 3;
}

async function completeOneShot(
  harness: Harness,
  direction: 'expense' | 'income',
  updateBase: number,
  amount: string,
  counterparty: string,
  identity: TelegramUserIdentity = user(),
): Promise<string> {
  let updateId = await advanceToAmount(harness, direction, updateBase, identity);
  await harness.engine.handleUpdate(messageUpdate(updateId++, amount, identity));
  await harness.engine.handleUpdate(messageUpdate(updateId++, counterparty, identity));
  await harness.engine.handleUpdate(messageUpdate(updateId++, '-', identity));
  await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co'), identity));
  await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt'), identity));
  const confirm = actionButton(harness, 'cf');
  await harness.engine.handleUpdate(callbackUpdate(updateId, confirm, identity));
  return confirm;
}

describe('Telegram bank chat flows', () => {
  it('shows an import prompt without seeding from the bot, then renders the canonical dashboard', async () => {
    const harness = createHarness();
    harness.repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada Lovelace',
    });
    harness.repository.updateUser('42', { stage: 'complete' });
    harness.repository.setLedgerMode('server');

    await harness.engine.handleUpdate(messageUpdate(1, '/start'));

    expect(harness.repository.getBankState('42')).toBeNull();
    expect(harness.transport.sent.at(-1)?.text).toContain('Open Cometa once');
    expect(callbackButtons(harness.transport.sent.at(-1)?.replyMarkup)).toEqual([]);

    activateUser(harness);
    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(messageUpdate(2, '/start'));

    const dashboard = harness.transport.sent.at(-1);
    expect(dashboard?.text).toContain('<b>Cometa · Ada</b>');
    expect(dashboard?.text).toContain('active accounts');
    expect(lastButtons(harness).map((candidate) => candidate.text)).toEqual([
      'Record expense',
      'Record income',
      'Accounts',
      'Recurring',
      'Settings',
    ]);
  });

  it('uses the correct Russian plural form for five active accounts', async () => {
    const harness = createHarness();
    const identity = user('42', 'ru');
    activateUser(harness, identity);
    harness.service.executeCommand({
      telegramUserId: identity.id,
      sourceKind: 'tma',
      operationId: 'd'.repeat(32),
      rawCommand: {
        kind: 'add_account',
        accountId: 'acc_thb_plural',
        currency: 'THB',
        name: 'Баты',
        number: 'CM05THB000000000005',
      },
    });

    await harness.engine.handleUpdate(messageUpdate(3, '/start', identity));

    expect(harness.transport.sent.at(-1)?.text).toContain('5 активных счетов');
  });

  it('records a one-shot expense and income with escaped text and ledger-derived balances', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const before = balanceOf(initial, checking.id);

    await completeOneShot(harness, 'expense', 10, '100.00', '<Spotify>');
    const afterExpense = canonicalState(harness);
    expect(balanceOf(afterExpense, checking.id)).toBe(before - 10_000);
    expect(afterExpense.transactions.at(-1)).toMatchObject({
      accountId: checking.id,
      amountMinor: -10_000,
      kind: 'manual_expense',
      counterparty: '<Spotify>',
      effectiveDate: '2026-09-05',
    });
    expect(harness.transport.sent.at(-1)?.text).toContain('Transaction recorded');

    await completeOneShot(harness, 'income', 30, '50.00', 'ACME & Co');
    const afterIncome = canonicalState(harness);
    expect(balanceOf(afterIncome, checking.id)).toBe(before - 5_000);
    expect(afterIncome.transactions.at(-1)).toMatchObject({
      amountMinor: 5_000,
      kind: 'manual_income',
      counterparty: 'ACME & Co',
    });
    const review = harness.transport.sent.find((message) => message.text.includes('ACME'))?.text ?? '';
    expect(review).toContain('ACME &amp; Co');
    expect(review).not.toContain('ACME & Co');
  });

  it('normalizes long whitespace-padded amounts before previews and confirmation', async () => {
    const harness = createHarness();
    activateUser(harness);
    let updateId = await advanceToAmount(harness, 'expense', 60);

    await harness.engine.handleUpdate(messageUpdate(updateId++, `${' '.repeat(80)}1000000.00${' '.repeat(80)}`));
    expect(harness.repository.getConversationSession('42')).toMatchObject({
      step: 'transaction_counterparty',
      draft: expect.objectContaining({ amountInput: '1000000.00' }),
    });
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Padded amount merchant'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt')));
    expect(harness.transport.sent.at(-1)?.text).toContain('This would overdraw the account');
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'am')));
    await harness.engine.handleUpdate(messageUpdate(updateId++, `${' '.repeat(80)}12.00${' '.repeat(80)}`));

    expect(harness.repository.getConversationSession('42')).toMatchObject({
      step: 'transaction_confirm',
      draft: expect.objectContaining({ amountInput: '12.00' }),
    });
    await harness.engine.handleUpdate(callbackUpdate(updateId, actionButton(harness, 'cf')));

    expect(harness.transport.sent.at(-1)?.text).toContain('Transaction recorded');
    expect(canonicalState(harness).transactions).toContainEqual(expect.objectContaining({
      kind: 'manual_expense',
      counterparty: 'Padded amount merchant',
      amountMinor: -1_200,
    }));
  });

  it('expires an older confirmation after a recoverable amount edit', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    let updateId = await advanceToAmount(harness, 'expense', 75);

    await harness.engine.handleUpdate(messageUpdate(updateId++, '100.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Versioned review merchant'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt')));
    const originalConfirm = actionButton(harness, 'cf');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '7'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '50.00',
        locale: 'en',
      },
    });
    await harness.engine.handleUpdate(callbackUpdate(updateId++, originalConfirm));
    expect(harness.transport.sent.at(-1)?.text).toContain('This would overdraw the account');
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'am')));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '25.00'));
    const replacementConfirm = actionButton(harness, 'cf');
    expect(replacementConfirm).not.toBe(originalConfirm);

    await harness.engine.handleUpdate(callbackUpdate(updateId++, originalConfirm));
    expect(harness.transport.answers.at(-1)?.text).toBe('This button has expired');
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(5_000);
    expect(harness.repository.getConversationSession('42')).toMatchObject({
      step: 'transaction_confirm',
    });

    await harness.engine.handleUpdate(callbackUpdate(updateId, replacementConfirm));
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(2_500);
  });

  it('invalidates a monetary review when a settings callback changes the language', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const before = balanceOf(initial, checking.id);
    let updateId = await advanceToAmount(harness, 'expense', 90);

    await harness.engine.handleUpdate(messageUpdate(updateId++, '1,000.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Locale review merchant'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt')));
    const englishConfirm = actionButton(harness, 'cf');

    await harness.engine.handleUpdate(callbackUpdate(updateId++, 'setlang:ru'));
    expect(harness.repository.getUser('42')).toMatchObject({ locale: 'ru' });
    expect(harness.repository.getConversationSession('42')).toMatchObject({ step: 'dashboard' });
    await harness.engine.handleUpdate(callbackUpdate(updateId, englishConfirm));

    expect(harness.transport.answers.at(-1)?.text).toBe('Кнопка устарела');
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(before);
    expect(canonicalState(harness).transactions).not.toContainEqual(expect.objectContaining({
      counterparty: 'Locale review merchant',
    }));
  });

  it('persists a transaction draft across restart and rejects stale or foreign callbacks under 64 bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-flow-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const now = { value: DEFAULT_NOW };
      const first = createHarness(path, now);
      activateUser(first);
      await first.engine.handleUpdate(messageUpdate(1, '/start'));
      const dashboardCallback = actionButton(first, 'te');
      const dashboardCallbacks = lastButtons(first).map((candidate) => candidate.data);
      expect(dashboardCallbacks.every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);

      await first.engine.handleUpdate(messageUpdate(2, '/add'));
      await first.engine.handleUpdate(callbackUpdate(3, actionButton(first, 'td', 'e')));
      await first.engine.handleUpdate(callbackUpdate(4, actionButton(first, 'ac', '0')));
      expect(first.repository.getConversationSession('42')).toMatchObject({ step: 'transaction_amount' });
      first.repository.close();
      repositories.delete(first.repository);

      const restarted = createHarness(path, now);
      await restarted.engine.handleUpdate(messageUpdate(5, '25.00'));
      expect(restarted.repository.getConversationSession('42')).toMatchObject({ step: 'transaction_counterparty' });
      expect(restarted.transport.sent.at(-1)?.text).toContain('Who sent or received');

      await restarted.engine.handleUpdate(callbackUpdate(6, dashboardCallback));
      expect(restarted.transport.answers.at(-1)?.text).toBe('This button has expired');

      const other = user('43');
      await restarted.engine.handleUpdate(callbackUpdate(7, dashboardCallback, other));
      expect(restarted.repository.getConversationSession('43')).toBeNull();
      expect(restarted.transport.answers.at(-1)?.text).toBe('This button has expired');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not reinterpret a replayed wizard update after a crash before reply delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-flow-receipt-'));
    const path = join(directory, 'bot.sqlite');
    const now = { value: DEFAULT_NOW };
    try {
      const first = createHarness(path, now);
      activateUser(first);
      const amountUpdateId = await advanceToAmount(first, 'expense', 50);
      first.transport.sendErrors.push(new Error('simulated crash before Telegram accepted reply'));

      await expect(first.engine.handleUpdate(messageUpdate(amountUpdateId, '25.00')))
        .rejects.toThrow('simulated crash');
      expect(first.repository.getConversationSession('42')).toMatchObject({
        step: 'transaction_counterparty',
        draft: expect.objectContaining({ amountInput: '25.00' }),
      });
      expect(first.repository.getConversationReply(amountUpdateId)).toMatchObject({
        status: 'pending',
        text: expect.stringContaining('Who sent or received'),
      });
      first.repository.close();
      repositories.delete(first.repository);

      const deliveryRestart = createHarness(path, now);
      await deliveryRestart.engine.handleUpdate(messageUpdate(amountUpdateId, '25.00'));
      expect(deliveryRestart.transport.sent).toHaveLength(1);
      expect(deliveryRestart.transport.sent[0]?.text).toContain('Who sent or received');
      expect(deliveryRestart.repository.getConversationSession('42')).toMatchObject({
        step: 'transaction_counterparty',
      });
      expect(deliveryRestart.repository.getConversationReply(amountUpdateId)).toMatchObject({
        status: 'delivered',
      });
      deliveryRestart.repository.close();
      repositories.delete(deliveryRestart.repository);

      const processedMarkerCrashRestart = createHarness(path, now);
      await processedMarkerCrashRestart.engine.handleUpdate(messageUpdate(amountUpdateId, '25.00'));
      expect(processedMarkerCrashRestart.transport.sent).toHaveLength(0);
      expect(processedMarkerCrashRestart.repository.getConversationSession('42')).toMatchObject({
        step: 'transaction_counterparty',
      });

      await processedMarkerCrashRestart.engine.handleUpdate(
        messageUpdate(amountUpdateId + 1, 'Spotify'),
      );
      expect(processedMarkerCrashRestart.repository.getConversationSession('42')).toMatchObject({
        step: 'transaction_note',
        draft: expect.objectContaining({ counterparty: 'Spotify' }),
      });
      expect(processedMarkerCrashRestart.transport.sent.at(-1)?.text).toContain('<b>Note</b>');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains an unprocessed orphan reply before handling a newer wizard update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-flow-orphan-reply-'));
    const path = join(directory, 'bot.sqlite');
    const now = { value: DEFAULT_NOW };
    try {
      const first = createHarness(path, now);
      activateUser(first);
      const amountUpdateId = await advanceToAmount(first, 'expense', 70);
      first.transport.sendErrors.push(new Error('simulated crash before reply delivery'));

      await expect(first.engine.handleUpdate(messageUpdate(amountUpdateId, '25.00')))
        .rejects.toThrow('simulated crash');
      expect(first.repository.getConversationReply(amountUpdateId)).toMatchObject({
        status: 'pending',
        updateProcessed: false,
      });
      first.repository.close();
      repositories.delete(first.repository);

      const restarted = createHarness(path, now);
      await expect(
        restarted.engine.handleUpdate(messageUpdate(amountUpdateId + 1, 'Spotify')),
      ).resolves.toBeUndefined();

      expect(restarted.transport.sent).toHaveLength(2);
      expect(restarted.transport.sent[0]?.text).toContain('Who sent or received');
      expect(restarted.transport.sent[1]?.text).toContain('<b>Note</b>');
      expect(restarted.repository.getConversationReply(amountUpdateId)).toMatchObject({
        status: 'delivered',
        updateProcessed: false,
      });
      expect(restarted.repository.getConversationSession('42')).toMatchObject({
        step: 'transaction_note',
        draft: expect.objectContaining({ counterparty: 'Spotify' }),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shows a visible restart path after a text or button expires', async () => {
    const now = { value: DEFAULT_NOW };
    const harness = createHarness(':memory:', now);
    activateUser(harness);

    await advanceToAmount(harness, 'expense', 80);
    now.value = '2026-09-06T12:00:00.000Z';
    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(messageUpdate(84, '25.00'));

    expect(harness.transport.sent.at(-1)?.text).toContain(
      'Start again with /add, /accounts, or /recurring',
    );

    await harness.engine.handleUpdate(messageUpdate(85, '/add'));
    const expiredButton = actionButton(harness, 'td', 'e');
    now.value = '2026-09-07T12:00:00.000Z';
    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(callbackUpdate(86, expiredButton));

    expect(harness.transport.answers.at(-1)?.text).toBe('This button has expired');
    expect(harness.transport.sent.at(-1)?.text).toContain(
      'Start again with /add, /accounts, or /recurring',
    );
  });

  it('localizes deterministic account names in both bot languages', async () => {
    const english = createHarness();
    activateUser(english);
    await english.engine.handleUpdate(messageUpdate(90, '/accounts'));
    const englishLabels = lastButtons(english).map((candidate) => candidate.text);
    expect(englishLabels).toEqual(expect.arrayContaining([
      expect.stringContaining('KZT · Current'),
      expect.stringContaining('USD · US dollar account'),
    ]));
    expect(englishLabels.join(' ')).not.toContain('Накопительный');

    const russian = createHarness();
    activateUser(russian, user('43', 'ru'), 'GEL');
    await russian.engine.handleUpdate(messageUpdate(91, '/accounts', user('43', 'ru')));
    const russianLabels = lastButtons(russian).map((candidate) => candidate.text);
    expect(russianLabels).toEqual(expect.arrayContaining([
      expect.stringContaining('GEL · Текущий'),
      expect.stringContaining('USD · Доллары'),
    ]));
    expect(russianLabels.join(' ')).not.toContain('Savings');
  });

  it('previews and atomically backfills a monthly expense, while rejecting an overdraft with exact amounts', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const beforeCount = initial.transactions.length;

    let updateId = await advanceToAmount(harness, 'expense', 100);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '100.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Spotify'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Family plan'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'cm')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'yr', '2026')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'mo', '1')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'da', '5')));

    expect(harness.transport.sent.at(-1)?.text).toContain('Backfill through Sep 5, 2026: <b>9</b> entries');
    expect(harness.transport.sent.at(-1)?.text).toContain('Balance after');
    await harness.engine.handleUpdate(callbackUpdate(updateId, actionButton(harness, 'cf')));

    const recurringState = canonicalState(harness);
    expect(recurringState.recurringRules).toHaveLength(1);
    const added = recurringState.transactions.slice(beforeCount);
    expect(added.filter((transaction) =>
      transaction.recurringRuleId === recurringState.recurringRules[0]?.id)).toHaveLength(9);
    expect(added.filter((transaction) =>
      transaction.accountId === 'acc_savings' && transaction.kind === 'interest')).toHaveLength(1);

    const countBeforeRejected = recurringState.transactions.length;
    updateId = await advanceToAmount(harness, 'expense', 200);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '100000.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Rent'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'cm')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'yr', '2026')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'mo', '1')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'da', '5')));

    const rejection = harness.transport.sent.at(-1)?.text ?? '';
    expect(rejection).toContain('This would overdraw the account');
    expect(rejection).toContain('Available:');
    expect(rejection).toContain('Required:');
    expect(canonicalState(harness).transactions).toHaveLength(countBeforeRejected);

    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'am')));
    expect(harness.repository.getConversationSession('42')).toMatchObject({
      step: 'transaction_edit_amount',
    });
    await harness.engine.handleUpdate(messageUpdate(updateId++, '1.00'));
    expect(harness.transport.sent.at(-1)?.text).toContain('Backfill through Sep 5, 2026: <b>9</b> entries');
    await harness.engine.handleUpdate(callbackUpdate(updateId, actionButton(harness, 'cf')));

    const repaired = canonicalState(harness);
    expect(repaired.recurringRules).toHaveLength(2);
    expect(repaired.transactions.filter((transaction) =>
      transaction.recurringRuleId === repaired.recurringRules[1]?.id)).toHaveLength(9);
  });

  it.each([
    ['expense', 'en'],
    ['income', 'en'],
    ['expense', 'ru'],
    ['income', 'ru'],
  ] as const)('rechecks the total when repairing %s in %s without implying an available-balance cap', async (direction, locale) => {
    const harness = createHarness();
    const identity = user('42', locale);
    activateUser(harness, identity);
    const initial = canonicalState(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const before = balanceOf(initial, checking.id);
    let updateId = await advanceToAmount(harness, direction, 210, identity);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '90071992547409.91', identity));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Amount correction', identity));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-', identity));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co'), identity));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt'), identity));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'am'), identity));

    expect(harness.transport.sent.at(-1)?.text).toBe(locale === 'ru'
      ? '<b>Новая сумма · KZT</b>\nВведите новую сумму больше нуля. Проверим итог перед сохранением.'
      : '<b>New amount · KZT</b>\nEnter a new positive amount. We’ll check the total before saving.');
    expect(harness.repository.getConversationSession(identity.id)).toMatchObject({
      step: 'transaction_edit_amount',
    });
    expect(canonicalState(harness).transactions).toEqual(initial.transactions);

    const correctedMinor = direction === 'income' ? before + 100 : 100;
    await harness.engine.handleUpdate(messageUpdate(updateId++, (correctedMinor / 100).toFixed(2), identity));
    await harness.engine.handleUpdate(callbackUpdate(updateId, actionButton(harness, 'cf'), identity));
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(
      before + (direction === 'income' ? correctedMinor : -correctedMinor),
    );
  });

  it('offers and imports the complete 120-month UTC recurrence window', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const before = initial.transactions.length;
    let updateId = await advanceToAmount(harness, 'income', 230);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '1.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Archive stipend'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'cm')));

    expect(lastButtons(harness).map((candidate) => candidate.text)).toContain('2016');
    expect(harness.transport.sent.at(-1)?.text).toContain('UTC calendar');
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'yr', '2016')));
    const monthLabels = lastButtons(harness).map((candidate) => candidate.text);
    expect(monthLabels).toContain('Oct');
    expect(monthLabels).not.toContain('Sep');
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'mo', '10')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'da', '5')));

    const review = harness.transport.sent.at(-1)?.text ?? '';
    expect(review).toContain('day 5 · UTC');
    expect(review).toContain('Backfill through Sep 5, 2026');
    expect(review).toContain('Backfill through Sep 5, 2026: <b>120</b> entries');
    await harness.engine.handleUpdate(callbackUpdate(updateId, actionButton(harness, 'cf')));

    const state = canonicalState(harness);
    const added = state.transactions.slice(before);
    expect(added.filter((transaction) =>
      transaction.counterparty === 'Archive stipend')).toHaveLength(120);
    expect(added.filter((transaction) =>
      transaction.accountId === 'acc_savings' && transaction.kind === 'interest')).toHaveLength(1);
    expect(state.recurringRules[0]).toMatchObject({
      direction: 'income',
      category: 'transfer',
    });
  });

  it('surfaces a future insufficient-funds pause on the dashboard without a partial row', async () => {
    const now = { value: DEFAULT_NOW };
    const harness = createHarness(':memory:', now);
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '300',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_future_pause',
        accountId: checking.id,
        direction: 'expense',
        amountInput: '1.00',
        locale: 'en',
        counterparty: 'Cloud storage',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 5,
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '301',
      chatId: '42',
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    await harness.engine.flushPendingReplies();
    const before = canonicalState(harness).transactions.filter((transaction) =>
      transaction.accountId === checking.id).length;

    now.value = '2026-10-05T12:00:00.000Z';
    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(messageUpdate(302, '/start'));
    await harness.engine.flushPendingReplies();

    const state = canonicalState(harness);
    expect(state.transactions.filter((transaction) =>
      transaction.accountId === checking.id)).toHaveLength(before);
    expect(state.recurringRules[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'insufficient_funds',
      nextOccurrence: '2026-10-05',
    });
    const warning = harness.transport.sent.at(-1)?.text ?? '';
    expect(warning).toContain('<b>Recurring entry was paused</b>');
    expect(warning).toContain('Was paused: <b>Cloud storage</b>');
    expect(warning).toContain('₸0.00 was available');
    expect(warning).toContain('₸1.00 was required');
    await harness.engine.flushPendingReplies();
    expect(harness.transport.sent.filter((message) =>
      message.text.includes('<b>Recurring entry was paused</b>'))).toHaveLength(1);
  });

  it('surfaces a materialization warning once before a non-dashboard command', async () => {
    const now = { value: DEFAULT_NOW };
    const harness = createHarness(':memory:', now);
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '350',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_command_warning',
        accountId: checking.id,
        direction: 'expense',
        amountInput: '1.00',
        locale: 'en',
        counterparty: 'Secure cloud',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 5,
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '351',
      chatId: '42',
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    await harness.engine.flushPendingReplies();
    const before = canonicalState(harness).transactions.filter((transaction) =>
      transaction.accountId === checking.id).length;

    now.value = '2026-10-05T12:00:00.000Z';
    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(messageUpdate(352, '/accounts'));
    await harness.engine.flushPendingReplies();

    expect(harness.transport.sent).toHaveLength(2);
    expect(harness.transport.sent[0]?.text).toContain('<b>Accounts</b>');
    expect(harness.transport.sent[1]?.text).toContain('<b>Recurring entry was paused</b>');
    expect(harness.transport.sent[1]?.text).toContain('Was paused: <b>Secure cloud</b>');
    expect(harness.transport.sent[1]?.text).toContain('₸0.00 was available');
    expect(harness.transport.sent[1]?.text).toContain('₸1.00 was required');

    const state = canonicalState(harness);
    expect(state.transactions.filter((transaction) =>
      transaction.accountId === checking.id)).toHaveLength(before);
    expect(state.recurringRules[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'insufficient_funds',
    });
  });

  it('keeps a canonical-preference materialization warning durable across send failure and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-warning-restart-'));
    const path = join(directory, 'bot.sqlite');
    const now = { value: DEFAULT_NOW };
    try {
      const first = createHarness(path, now);
      const initial = activateUser(first);
      const checking = initial.accounts.find((account) => account.role === 'primary-checking');
      if (checking === undefined) throw new Error('Missing checking account');
      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '360',
        chatId: '42',
        rawCommand: {
          kind: 'create_recurring',
          ruleId: 'rr_durable_warning',
          accountId: checking.id,
          direction: 'expense',
          amountInput: '1.00',
          locale: 'en',
          counterparty: 'Durable cloud',
          startYear: 2026,
          startMonth: 9,
          anchorDay: 5,
        },
      });
      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '361',
        chatId: '42',
        rawCommand: {
          kind: 'adjust_balance',
          accountId: checking.id,
          targetAmountInput: '0',
          locale: 'en',
        },
      });
      await first.engine.flushPendingReplies();

      now.value = '2026-10-05T12:00:00.000Z';
      first.transport.sent.length = 0;
      await first.engine.handleUpdate(callbackUpdate(362, 'settings:language'));
      expect(first.repository.listBankOutbox()).toHaveLength(1);
      first.transport.sendErrors.push(new Error('temporary warning send failure'));
      await first.engine.flushPendingReplies();
      expect(first.repository.listBankOutbox()[0]).toMatchObject({ attempts: 1 });

      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'f'.repeat(32),
        rawCommand: { kind: 'pause_recurring', ruleId: 'rr_durable_warning' },
      });
      expect(canonicalState(first).recurringRules[0]).toMatchObject({
        status: 'paused',
        pauseReason: 'manual',
      });

      await first.engine.handleUpdate(callbackUpdate(363, 'settings:language'));
      expect(first.repository.listBankOutbox()).toHaveLength(1);
      first.repository.close();
      repositories.delete(first.repository);

      now.value = '2026-10-05T12:00:01.000Z';
      const restarted = createHarness(path, now);
      await restarted.engine.flushPendingReplies();
      expect(restarted.transport.sent).toHaveLength(1);
      expect(restarted.transport.sent[0]?.text).toContain('<b>Recurring entry was paused</b>');
      expect(restarted.transport.sent[0]?.text).toContain('Was paused: <b>Durable cloud</b>');
      expect(restarted.transport.sent[0]?.text).toContain('₸0.00 was available');
      expect(restarted.transport.sent[0]?.text).toContain('₸1.00 was required');
      expect(restarted.transport.sent[0]?.text).not.toContain('paused by you');
      expect(restarted.repository.listBankOutbox()).toEqual([]);
      await restarted.engine.flushPendingReplies();
      expect(restarted.transport.sent).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders the original warning facts after the canonical ledger is reset and the bot restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-frozen-warning-'));
    const path = join(directory, 'bot.sqlite');
    const now = { value: DEFAULT_NOW };
    try {
      const first = createHarness(path, now);
      const initial = activateUser(first);
      const usd = initial.accounts.find((account) => account.id === 'acc_usd');
      if (usd === undefined) throw new Error('Missing USD account');
      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '364',
        chatId: '42',
        rawCommand: {
          kind: 'adjust_balance',
          accountId: usd.id,
          targetAmountInput: '0',
          locale: 'en',
        },
      });
      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '365',
        chatId: '42',
        rawCommand: {
          kind: 'create_recurring',
          ruleId: 'rr_original_cloud',
          accountId: usd.id,
          direction: 'expense',
          amountInput: '12.34',
          locale: 'en',
          counterparty: 'Original Cloud',
          startYear: 2026,
          startMonth: 9,
          anchorDay: 30,
        },
      });
      await first.engine.flushPendingReplies();
      first.transport.sent.length = 0;

      now.value = '2026-09-30T12:00:00.000Z';
      const stored = first.repository.getBankState('42');
      if (stored === null) throw new Error('Missing canonical state');
      const state = bankDomainAdapter.parseState(stored.state, now.value, {
        expectedTelegramId: '42',
      });
      if (state === null) throw new Error('Invalid canonical state');
      const materialized = bankDomainAdapter.materialize(state, now.value);
      const warningContexts = snapshotRecurringWarningContexts(
        materialized.state,
        materialized.warnings,
      );
      expect(warningContexts).toEqual([expect.objectContaining({
        counterparty: 'Original Cloud',
        currency: 'USD',
        availableMinor: 0,
        requiredMinor: 1_234,
      })]);
      first.repository.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'system',
        operationId: 'frozen-warning',
        commandHash: '1'.repeat(64),
        operationKind: 'materialize_recurring',
        chatId: '42',
      }, () => ({
        stateJson: bankDomainAdapter.serializeState(materialized.state),
        outcome: { warnings: materialized.warnings },
        outbox: {
          messageKind: 'bank_materialization_warning',
          payload: { warnings: materialized.warnings, warningContexts },
        },
      }));
      first.service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: '2'.repeat(32),
        rawCommand: { kind: 'reset_demo' },
      });
      first.repository.close();
      repositories.delete(first.repository);

      now.value = '2026-09-30T12:00:01.000Z';
      const restarted = createHarness(path, now);
      await restarted.engine.flushPendingReplies();

      const delivered = restarted.transport.sent.at(-1)?.text ?? '';
      expect(delivered).toContain('<b>Recurring entry was paused</b>');
      expect(delivered).toContain('Was paused: <b>Original Cloud</b>');
      expect(delivered).toContain('$0.00 was available');
      expect(delivered).toContain('$12.34 was required');
      expect(restarted.repository.listBankOutbox()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders legacy warning payloads without guessing facts from the current ledger', async () => {
    const harness = createHarness();
    activateUser(harness);
    harness.repository.executeBankOperation({
      telegramUserId: '42',
      sourceKind: 'system',
      operationId: 'legacy-warning',
      commandHash: '3'.repeat(64),
      operationKind: 'materialize_recurring',
      chatId: '42',
    }, (state) => ({
      stateJson: JSON.stringify(state),
      outcome: { warnings: [{ ruleId: 'rr_missing', reason: 'insufficient_funds' }] },
      outbox: {
        messageKind: 'bank_materialization_warning',
        payload: { warnings: [{ ruleId: 'rr_missing', reason: 'insufficient_funds' }] },
      },
    }));

    await harness.engine.flushPendingReplies();

    const delivered = harness.transport.sent.at(-1)?.text ?? '';
    expect(delivered).toContain('<b>Recurring entry was paused</b>');
    expect(delivered).toContain('the account lacked funds at that time');
    expect(delivered).not.toContain('rr_missing');
    expect(delivered).not.toContain('₸');
  });

  it('hands a TMA materialization warning to the durable bot outbox without duplicate delivery', async () => {
    const now = { value: DEFAULT_NOW };
    const harness = createHarness(':memory:', now);
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '370',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_tma_warning',
        accountId: checking.id,
        direction: 'expense',
        amountInput: '1.00',
        locale: 'en',
        counterparty: 'TMA cloud',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 5,
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '371',
      chatId: '42',
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    await harness.engine.flushPendingReplies();

    now.value = '2026-10-05T12:00:00.000Z';
    harness.transport.sent.length = 0;
    const response = harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'e'.repeat(32),
      rawCommand: {
        kind: 'set_display_name',
        displayName: 'Ada',
      },
    });
    expect(response.warnings).toEqual([
      expect.objectContaining({ ruleId: 'rr_tma_warning', reason: 'insufficient_funds' }),
    ]);
    expect(harness.repository.listBankOutbox()).toHaveLength(1);

    await harness.engine.flushPendingReplies();
    expect(harness.transport.sent).toHaveLength(1);
    expect(harness.transport.sent[0]?.text).toContain('<b>Recurring entry was paused</b>');
    expect(harness.transport.sent[0]?.text).toContain('Was paused: <b>TMA cloud</b>');
    await harness.engine.flushPendingReplies();
    expect(harness.transport.sent).toHaveLength(1);
  });

  it('adds, adjusts, closes, and restores a zero-balance account without deleting its ledger', async () => {
    const harness = createHarness();
    activateUser(harness);

    await harness.engine.handleUpdate(messageUpdate(400, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(401, actionButton(harness, 'aa')));
    await harness.engine.handleUpdate(callbackUpdate(402, textButton(harness, 'THB')));
    expect(harness.transport.sent.at(-1)?.text).toContain('Open demo account?');
    await harness.engine.handleUpdate(callbackUpdate(403, actionButton(harness, 'cf')));

    let state = canonicalState(harness);
    const account = state.accounts.find((candidate) => candidate.currency === 'THB');
    expect(account).toMatchObject({ type: 'checking', status: 'active', role: 'custom' });
    if (account === undefined) throw new Error('Missing THB account');
    expect(account.number).toMatch(/^CM05THB\d{15}$/);
    expect(account.number.slice(-4)).toMatch(/^\d{4}$/);
    expect(balanceOf(state, account.id)).toBe(0);
    const openingRow = state.transactions.find((transaction) => transaction.accountId === account.id);
    expect(openingRow).toMatchObject({ amountMinor: 0, kind: 'seed' });

    await harness.engine.handleUpdate(messageUpdate(410, '/accounts'));
    expect(lastButtons(harness).map((candidate) => candidate.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('THB · Everyday')]),
    );
    await harness.engine.handleUpdate(callbackUpdate(411, textButton(harness, 'THB')));
    await harness.engine.handleUpdate(callbackUpdate(412, actionButton(harness, 'aj')));
    await harness.engine.handleUpdate(messageUpdate(413, '1000.00'));
    await harness.engine.handleUpdate(callbackUpdate(414, actionButton(harness, 'cf')));
    state = canonicalState(harness);
    expect(balanceOf(state, account.id)).toBe(100_000);

    await harness.engine.handleUpdate(messageUpdate(420, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(421, textButton(harness, 'THB')));
    await harness.engine.handleUpdate(callbackUpdate(422, actionButton(harness, 'aj')));
    await harness.engine.handleUpdate(messageUpdate(423, '0'));
    await harness.engine.handleUpdate(callbackUpdate(424, actionButton(harness, 'cf')));
    const ledgerLengthAtZero = canonicalState(harness).transactions.length;

    await harness.engine.handleUpdate(messageUpdate(430, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(431, textButton(harness, 'THB')));
    await harness.engine.handleUpdate(callbackUpdate(432, actionButton(harness, 'cl')));
    await harness.engine.handleUpdate(callbackUpdate(433, actionButton(harness, 'cf')));
    state = canonicalState(harness);
    expect(state.accounts.find((candidate) => candidate.id === account.id)?.status).toBe('closed');
    expect(state.transactions).toHaveLength(ledgerLengthAtZero);

    await harness.engine.handleUpdate(messageUpdate(440, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(441, textButton(harness, 'THB')));
    await harness.engine.handleUpdate(callbackUpdate(442, actionButton(harness, 'rs')));
    await harness.engine.handleUpdate(callbackUpdate(443, actionButton(harness, 'cf')));
    state = canonicalState(harness);
    expect(state.accounts.find((candidate) => candidate.id === account.id)?.status).toBe('active');
    expect(state.transactions).toHaveLength(ledgerLengthAtZero);

    harness.repository.updateUser('42', { locale: 'ru' });
    await harness.engine.handleUpdate(messageUpdate(444, '/accounts'));
    expect(lastButtons(harness).map((candidate) => candidate.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('THB · Повседневный')]),
    );
  });

  it('normalizes a long whitespace-padded balance before review and confirmation', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');

    await harness.engine.handleUpdate(messageUpdate(450, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(451, textButton(harness, 'KZT · Current')));
    await harness.engine.handleUpdate(callbackUpdate(452, actionButton(harness, 'aj')));
    await harness.engine.handleUpdate(messageUpdate(
      453,
      `${' '.repeat(80)}500.00${' '.repeat(80)}`,
    ));

    expect(harness.repository.getConversationSession('42')).toMatchObject({
      step: 'account_confirm',
      draft: expect.objectContaining({ targetAmountInput: '500.00' }),
    });
    expect(harness.transport.sent.at(-1)?.text).toContain('<b>Adjust balance?</b>');
    await harness.engine.handleUpdate(callbackUpdate(454, actionButton(harness, 'cf')));

    expect(balanceOf(canonicalState(harness), checking.id)).toBe(50_000);
  });

  it('rechecks an account review after canonical state changes before confirmation', async () => {
    const harness = createHarness();
    activateUser(harness);
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '8'.repeat(32),
      rawCommand: {
        kind: 'add_account',
        accountId: 'acc_bot_f123456789ab',
        currency: 'THB',
        name: 'Everyday THB',
        number: 'CM05THB000000000000001',
      },
    });

    await harness.engine.handleUpdate(messageUpdate(460, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(461, textButton(harness, 'THB')));
    await harness.engine.handleUpdate(callbackUpdate(462, actionButton(harness, 'cl')));
    const closeConfirm = actionButton(harness, 'cf');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '9'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: 'acc_bot_f123456789ab',
        targetAmountInput: '10.00',
        locale: 'en',
      },
    });

    await harness.engine.handleUpdate(callbackUpdate(463, closeConfirm));

    expect(harness.transport.sent.at(-1)?.text).toContain('Adjust the account balance to zero first');
    expect(lastButtons(harness).map((candidate) => candidate.text)).toContain('Dashboard');
    expect(canonicalState(harness).accounts.find(
      (account) => account.id === 'acc_bot_f123456789ab',
    )).toMatchObject({ status: 'active' });
    expect(balanceOf(canonicalState(harness), 'acc_bot_f123456789ab')).toBe(1_000);
  });

  it('rechecks a still-valid balance adjustment when its reviewed balance changed', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'a'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '1000.00',
        locale: 'en',
      },
    });

    await harness.engine.handleUpdate(messageUpdate(470, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(471, textButton(harness, 'KZT · Current')));
    await harness.engine.handleUpdate(callbackUpdate(472, actionButton(harness, 'aj')));
    await harness.engine.handleUpdate(messageUpdate(473, '500.00'));
    const staleConfirm = actionButton(harness, 'cf');
    const reviewedFlow = harness.repository.getConversationSession('42')?.flowId;

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'b'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    await harness.engine.handleUpdate(callbackUpdate(474, staleConfirm));

    expect(balanceOf(canonicalState(harness), checking.id)).toBe(0);
    expect(harness.transport.sent.at(-1)?.text).toContain('Current: ₸0.00');
    expect(harness.transport.sent.at(-1)?.text).toContain('Target: <b>₸500.00</b>');
    const refreshedFlow = harness.repository.getConversationSession('42')?.flowId;
    expect(refreshedFlow).not.toBe(reviewedFlow);
    const refreshedConfirm = actionButton(harness, 'cf');

    await harness.engine.handleUpdate(callbackUpdate(475, staleConfirm));
    expect(harness.transport.sent.at(-1)?.text).toContain('This step has expired');
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(0);

    await harness.engine.handleUpdate(callbackUpdate(476, refreshedConfirm));
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(50_000);
  });

  it('settles savings interest before applying a current-only balance correction', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const savings = initial.accounts.find((account) => account.type === 'savings');
    if (savings === undefined) throw new Error('Missing savings account');
    const beforeLength = initial.transactions.length;

    await harness.engine.handleUpdate(messageUpdate(500, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(501, textButton(harness, 'Savings')));
    await harness.engine.handleUpdate(callbackUpdate(502, actionButton(harness, 'aj')));
    expect(harness.transport.sent.at(-1)?.text).toContain('Interest settles');
    await harness.engine.handleUpdate(messageUpdate(503, '1000.00'));
    await harness.engine.handleUpdate(callbackUpdate(504, actionButton(harness, 'cf')));

    const state = canonicalState(harness);
    expect(balanceOf(state, savings.id)).toBe(100_000);
    expect(state.transactions.length).toBeGreaterThan(beforeLength);
    expect(state.transactions.some((transaction) =>
      transaction.accountId === savings.id && transaction.kind === 'balance_adjustment')).toBe(true);
  });

  it('lists recurring entries and pauses or resumes them without rewriting history', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '550',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_pause_resume',
        accountId: checking.id,
        direction: 'income',
        amountInput: '10.00',
        locale: 'en',
        counterparty: 'Studio retainer',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 5,
      },
    });
    await harness.engine.flushPendingReplies();
    const historyLength = canonicalState(harness).transactions.length;

    await harness.engine.handleUpdate(messageUpdate(551, '/recurring'));
    await harness.engine.handleUpdate(callbackUpdate(552, textButton(harness, 'Studio retainer')));
    expect(harness.transport.sent.at(-1)?.text).toContain('Status: <b>Active</b>');
    await harness.engine.handleUpdate(callbackUpdate(553, actionButton(harness, 'rp')));
    expect(harness.transport.sent.at(-1)?.text).toContain('Existing history will not change');
    await harness.engine.handleUpdate(callbackUpdate(554, actionButton(harness, 'cf')));
    expect(canonicalState(harness).recurringRules[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'manual',
    });
    expect(canonicalState(harness).transactions).toHaveLength(historyLength);

    await harness.engine.handleUpdate(messageUpdate(555, '/recurring'));
    await harness.engine.handleUpdate(callbackUpdate(556, textButton(harness, 'Studio retainer')));
    await harness.engine.handleUpdate(callbackUpdate(557, actionButton(harness, 'rr')));
    await harness.engine.handleUpdate(callbackUpdate(558, actionButton(harness, 'cf')));
    expect(canonicalState(harness).recurringRules[0]).toMatchObject({ status: 'active' });
    expect(canonicalState(harness).transactions).toHaveLength(historyLength);
  });

  it('routes an account-closed recurrence to account restoration instead of an impossible resume', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '580',
      chatId: '42',
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '581',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_closed_account',
        accountId: checking.id,
        direction: 'expense',
        amountInput: '1.00',
        locale: 'en',
        counterparty: 'Future storage',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '582',
      chatId: '42',
      rawCommand: { kind: 'close_account', accountId: checking.id },
    });
    await harness.engine.flushPendingReplies();

    await harness.engine.handleUpdate(messageUpdate(583, '/recurring'));
    await harness.engine.handleUpdate(callbackUpdate(584, textButton(harness, 'Future storage')));
    expect(harness.transport.sent.at(-1)?.text).toContain(
      'Restore the account and this entry will resume automatically',
    );
    expect(lastButtons(harness).map((candidate) => candidate.text)).toContain('Manage accounts');
    expect(lastButtons(harness).map((candidate) => candidate.text)).not.toContain('Resume');

    await harness.engine.handleUpdate(callbackUpdate(585, actionButton(harness, 'ma')));
    expect(harness.transport.sent.at(-1)?.text).toContain('<b>Accounts</b>');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '586',
      chatId: '42',
      rawCommand: { kind: 'restore_account', accountId: checking.id },
    });
    const restoredRule = canonicalState(harness).recurringRules[0];
    expect(restoredRule).toMatchObject({ status: 'active' });
    expect(restoredRule).not.toHaveProperty('pauseReason');
  });

  it('refreshes a recurring review when its rule changes before confirmation', async () => {
    const harness = createHarness();
    activateUser(harness);
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'c'.repeat(32),
      rawCommand: {
        kind: 'add_account',
        accountId: 'acc_recurring_drift',
        currency: 'THB',
        name: 'Everyday THB',
        number: 'CM05THB000000000000002',
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '590',
      chatId: '42',
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_review_drift',
        accountId: 'acc_recurring_drift',
        direction: 'income',
        amountInput: '10.00',
        locale: 'en',
        counterparty: 'Review drift',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
    });
    await harness.engine.flushPendingReplies();

    await harness.engine.handleUpdate(messageUpdate(591, '/recurring'));
    await harness.engine.handleUpdate(callbackUpdate(592, textButton(harness, 'Review drift')));
    await harness.engine.handleUpdate(callbackUpdate(593, actionButton(harness, 'rp')));
    const staleConfirm = actionButton(harness, 'cf');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'd'.repeat(32),
      rawCommand: { kind: 'close_account', accountId: 'acc_recurring_drift' },
    });
    await harness.engine.handleUpdate(callbackUpdate(594, staleConfirm));

    expect(harness.transport.sent.at(-1)?.text).toContain('<b>State changed</b>');
    expect(canonicalState(harness).recurringRules.find(
      (rule) => rule.id === 'rr_review_drift',
    )).toMatchObject({ status: 'paused', pauseReason: 'account_closed' });

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: 'e'.repeat(32),
      rawCommand: { kind: 'restore_account', accountId: 'acc_recurring_drift' },
    });
    const restored = canonicalState(harness).recurringRules.find(
      (rule) => rule.id === 'rr_review_drift',
    );
    expect(restored).toMatchObject({ status: 'active' });
    expect(restored).not.toHaveProperty('pauseReason');
  });

  it('refreshes a recurring resume review when available funds change', async () => {
    const now = { value: DEFAULT_NOW };
    const harness = createHarness(':memory:', now);
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '1'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '1000.00',
        locale: 'en',
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '2'.repeat(32),
      rawCommand: {
        kind: 'create_recurring',
        ruleId: 'rr_balance_drift',
        accountId: checking.id,
        direction: 'expense',
        amountInput: '100.00',
        locale: 'en',
        counterparty: 'Balance drift',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
    });
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '3'.repeat(32),
      rawCommand: { kind: 'pause_recurring', ruleId: 'rr_balance_drift' },
    });
    now.value = '2026-10-30T12:00:00.000Z';

    await harness.engine.handleUpdate(messageUpdate(610, '/recurring'));
    await harness.engine.handleUpdate(callbackUpdate(611, textButton(harness, 'Balance drift')));
    await harness.engine.handleUpdate(callbackUpdate(612, actionButton(harness, 'rr')));
    const staleConfirm = actionButton(harness, 'cf');

    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'tma',
      operationId: '4'.repeat(32),
      rawCommand: {
        kind: 'adjust_balance',
        accountId: checking.id,
        targetAmountInput: '0',
        locale: 'en',
      },
    });
    await harness.engine.handleUpdate(callbackUpdate(613, staleConfirm));

    expect(harness.transport.sent.at(-1)?.text).toContain('<b>State changed</b>');
    expect(canonicalState(harness).recurringRules.find(
      (rule) => rule.id === 'rr_balance_drift',
    )).toMatchObject({ status: 'paused', pauseReason: 'manual' });
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(0);
  });

  it('replays a committed account confirmation after a crash before session cleanup', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const beforeAdjustments = initial.transactions.filter(
      (transaction) => transaction.accountId === checking.id && transaction.kind === 'balance_adjustment',
    ).length;

    await harness.engine.handleUpdate(messageUpdate(700, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(701, textButton(harness, 'KZT · Current')));
    await harness.engine.handleUpdate(callbackUpdate(702, actionButton(harness, 'aj')));
    await harness.engine.handleUpdate(messageUpdate(703, '500.00'));
    const confirm = actionButton(harness, 'cf');
    const deleteSession = harness.repository.deleteConversationSession.bind(harness.repository);
    const cleanup = vi.spyOn(harness.repository, 'deleteConversationSession')
      .mockImplementationOnce(() => {
        throw new Error('simulated crash after bank commit');
      })
      .mockImplementation(deleteSession);

    await expect(harness.engine.handleUpdate(callbackUpdate(704, confirm)))
      .rejects.toThrow('simulated crash after bank commit');
    expect(balanceOf(canonicalState(harness), checking.id)).toBe(50_000);
    expect(harness.repository.getConversationSession('42')).not.toBeNull();
    expect(harness.repository.listBankOutbox()).toHaveLength(1);

    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(callbackUpdate(704, confirm));
    cleanup.mockRestore();

    const finalState = canonicalState(harness);
    expect(finalState.transactions.filter(
      (transaction) => transaction.accountId === checking.id && transaction.kind === 'balance_adjustment',
    )).toHaveLength(beforeAdjustments + 1);
    expect(harness.repository.getConversationSession('42')).toBeNull();
    expect(harness.repository.listBankOutbox()).toEqual([]);
    expect(harness.transport.sent.at(-1)?.text).toContain('<b>Balance adjusted</b>');
  });

  it('writes name and primary-currency settings to canonical state after import', async () => {
    const harness = createHarness();
    activateUser(harness);

    await harness.engine.handleUpdate(callbackUpdate(570, 'currency:USD'));
    expect(canonicalState(harness).primaryCurrency).toBe('USD');
    expect(harness.repository.getUser('42')?.primaryCurrency).toBe('KZT');

    await harness.engine.handleUpdate(callbackUpdate(571, 'name:custom'));
    await harness.engine.handleUpdate(messageUpdate(572, '<Nova>'));
    expect(canonicalState(harness).profile.displayName).toBe('<Nova>');
    expect(harness.repository.getUser('42')?.displayName).toBe('Ada Lovelace');

    harness.transport.sent.length = 0;
    await harness.engine.handleUpdate(messageUpdate(573, '/start'));
    const dashboard = harness.transport.sent.at(-1)?.text ?? '';
    expect(dashboard).toContain('Cometa · &lt;Nova&gt;');
    expect(dashboard).not.toContain('Cometa · <Nova>');
  });

  it('finishes canonical currency onboarding but preserves an active custom-name prompt', async () => {
    const completed = createHarness();
    activateUser(completed);
    completed.repository.updateUser('42', { stage: 'currency' });
    completed.transport.sent.length = 0;

    await completed.engine.handleUpdate(callbackUpdate(574, 'currency:USD'));

    expect(completed.repository.getUser('42')?.stage).toBe('complete');
    expect(canonicalState(completed).primaryCurrency).toBe('USD');
    expect(completed.transport.sent.at(-1)?.text).toContain('<b>Cometa · Ada</b>');
    expect(completed.transport.sent.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.text)
      .toBe('Open Cometa');

    const naming = createHarness();
    activateUser(naming);
    naming.repository.updateUser('42', { stage: 'custom_name' });
    naming.transport.sent.length = 0;

    await naming.engine.handleUpdate(callbackUpdate(575, 'currency:GEL'));

    expect(naming.repository.getUser('42')?.stage).toBe('custom_name');
    expect(canonicalState(naming).primaryCurrency).toBe('GEL');
    expect(naming.transport.sent.at(-1)?.text).toContain('<b>Your name in Cometa</b>');
  });

  it('keeps canonical onboarding incomplete when the shared mutation budget rejects the choice', async () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 60_000 },
      command: { maximum: 1, windowMs: 60_000 },
      rates: { maximum: 1, windowMs: 60_000 },
    });
    const now = { value: DEFAULT_NOW };
    expect(limiter.consume({
      telegramUserId: '42',
      kind: 'command',
      sourceKind: 'tma',
      operationId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      replayFingerprint: '1'.repeat(64),
      durableReplay: false,
      nowMs: Date.parse(now.value),
    })).toBeNull();
    const harness = createHarness(':memory:', now, limiter);
    activateUser(harness);
    harness.repository.updateUser('42', { stage: 'currency' });
    harness.transport.sent.length = 0;

    await harness.engine.handleUpdate(callbackUpdate(576, 'currency:USD'));

    expect(harness.repository.getUser('42')?.stage).toBe('currency');
    expect(canonicalState(harness).primaryCurrency).toBe('KZT');
    expect(harness.transport.sent.at(-1)?.text).toContain('Too many changes at once');
  });

  it.each([
    ['en', '<b>Too many changes at once</b>\nWait 60 sec and confirm again.'],
    ['ru', '<b>Слишком много изменений подряд</b>\nПодождите 60 сек. и подтвердите ещё раз.'],
  ] as const)('shares the TMA mutation budget with %s Telegram confirmations', async (locale, copy) => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 60_000 },
      command: { maximum: 1, windowMs: 60_000 },
      rates: { maximum: 1, windowMs: 60_000 },
    });
    const now = { value: DEFAULT_NOW };
    expect(limiter.consume({
      telegramUserId: '42',
      kind: 'command',
      sourceKind: 'tma',
      operationId: 'dddddddddddddddddddddddddddddddd',
      replayFingerprint: '1'.repeat(64),
      durableReplay: false,
      nowMs: Date.parse(now.value),
    })).toBeNull();
    const harness = createHarness(':memory:', now, limiter);
    const identity = user('42', locale);
    activateUser(harness, identity);
    const before = canonicalState(harness).transactions.length;

    await completeOneShot(harness, 'expense', 700, '10.00', 'Coffee', identity);

    expect(canonicalState(harness).transactions).toHaveLength(before);
    expect(harness.repository.getConversationSession('42')?.step).toBe('transaction_confirm');
    expect(harness.transport.sent.at(-1)?.text).toBe(copy);
  });

  it('retries bank outbox rows independently so one user cannot block another', async () => {
    const harness = createHarness();
    activateUser(harness, user('42'));
    activateUser(harness, user('43'));
    harness.service.executeCommand({
      telegramUserId: '42',
      sourceKind: 'telegram',
      operationId: '580',
      chatId: '42',
      rawCommand: { kind: 'set_primary_currency', currency: 'USD' },
    });
    harness.service.executeCommand({
      telegramUserId: '43',
      sourceKind: 'telegram',
      operationId: '581',
      chatId: '43',
      rawCommand: { kind: 'set_primary_currency', currency: 'EUR' },
    });
    harness.transport.sendErrors.push(new TelegramApiError('sendMessage', 429, 429, 37));

    await harness.engine.flushPendingReplies();

    expect(harness.transport.sent.map((message) => message.chatId)).toEqual(['43']);
    expect(harness.repository.listBankOutbox()).toEqual([
      expect.objectContaining({
        telegramUserId: '42',
        attempts: 1,
        nextAttemptAt: Date.parse('2026-09-05T12:00:37.000Z'),
      }),
    ]);

    harness.now.value = '2026-09-05T12:00:36.999Z';
    await harness.engine.flushPendingReplies();
    expect(harness.transport.sent.map((message) => message.chatId)).toEqual(['43']);

    harness.now.value = '2026-09-05T12:00:37.000Z';
    await harness.engine.flushPendingReplies();
    expect(harness.transport.sent.map((message) => message.chatId)).toEqual(['43', '42']);
    expect(harness.repository.listBankOutbox()).toEqual([]);
  });

  it('renders a delayed domain failure from immutable account context instead of a later wizard', async () => {
    const harness = createHarness();
    const initial = activateUser(harness);
    const checking = initial.accounts.find((account) => account.role === 'primary-checking');
    const usd = initial.accounts.find((account) => account.currency === 'USD');
    if (checking === undefined || usd === undefined) throw new Error('Missing fixture accounts');

    let updateId = await advanceToAmount(harness, 'expense', 750);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '10.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Coffee'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt')));
    const confirm = actionButton(harness, 'cf');

    const executeCommand = harness.service.executeCommand.bind(harness.service);
    const race = vi.spyOn(harness.service, 'executeCommand').mockImplementation((input) => {
      if (input.sourceKind === 'telegram' && input.operationId === String(updateId)) {
        executeCommand({
          telegramUserId: '42',
          sourceKind: 'tma',
          operationId: 'd'.repeat(32),
          rawCommand: {
            kind: 'adjust_balance',
            accountId: checking.id,
            targetAmountInput: '0',
            locale: 'en',
          },
        });
      }
      return executeCommand(input);
    });
    harness.transport.sendErrors.push(new Error('temporary result send failure'));
    await harness.engine.handleUpdate(callbackUpdate(updateId, confirm));
    race.mockRestore();
    expect(harness.repository.listBankOutbox()).toEqual([
      expect.objectContaining({
        attempts: 1,
        payload: expect.objectContaining({
          deliveryContext: { accountId: checking.id, currency: 'KZT' },
          failure: expect.objectContaining({ code: 'insufficient_funds' }),
        }),
      }),
    ]);

    await harness.engine.handleUpdate(messageUpdate(761, '/accounts'));
    await harness.engine.handleUpdate(callbackUpdate(762, textButton(harness, 'USD')));
    expect(harness.repository.getConversationSession('42')?.draft).toMatchObject({
      accountId: usd.id,
    });

    harness.now.value = '2026-09-05T12:00:01.000Z';
    await harness.engine.flushPendingReplies();
    const delivered = harness.transport.sent.at(-1)?.text ?? '';
    expect(delivered).toContain('Available: ₸0.00');
    expect(delivered).toContain('Required: ₸10.00');
    expect(delivered).not.toContain('Available: $');
  });

  it('keeps confirmation idempotent after a send failure and isolates two users', async () => {
    const harness = createHarness();
    const first = activateUser(harness, user('42'));
    const secondIdentity = user('43');
    const second = activateUser(harness, secondIdentity);
    const firstChecking = first.accounts.find((account) => account.role === 'primary-checking');
    const secondChecking = second.accounts.find((account) => account.role === 'primary-checking');
    if (firstChecking === undefined || secondChecking === undefined) throw new Error('Missing checking account');
    const secondBefore = balanceOf(second, secondChecking.id);

    let updateId = await advanceToAmount(harness, 'expense', 600);
    await harness.engine.handleUpdate(messageUpdate(updateId++, '10.00'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, 'Coffee'));
    await harness.engine.handleUpdate(messageUpdate(updateId++, '-'));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'co')));
    await harness.engine.handleUpdate(callbackUpdate(updateId++, actionButton(harness, 'dt')));
    const confirm = actionButton(harness, 'cf');
    const confirmationUpdateId = updateId;
    harness.transport.sendErrors.push(new Error('temporary send failure'));
    await expect(harness.engine.handleUpdate(callbackUpdate(confirmationUpdateId, confirm)))
      .resolves.toBeUndefined();

    const afterCommit = canonicalState(harness);
    expect(afterCommit.transactions.filter((transaction) =>
      transaction.kind === 'manual_expense' && transaction.counterparty === 'Coffee')).toHaveLength(1);
    expect(harness.repository.listBankOutbox()).toHaveLength(1);
    expect(harness.repository.getConversationSession('42')).toBeNull();

    await harness.engine.handleUpdate(callbackUpdate(confirmationUpdateId, confirm));
    expect(canonicalState(harness).transactions.filter((transaction) =>
      transaction.kind === 'manual_expense' && transaction.counterparty === 'Coffee')).toHaveLength(1);
    expect(harness.transport.answers.at(-1)?.text).toBe('This button has expired');

    harness.now.value = '2026-09-05T12:00:01.000Z';
    await harness.engine.flushPendingReplies();
    expect(harness.repository.listBankOutbox()).toHaveLength(0);
    expect(balanceOf(canonicalState(harness, '43'), secondChecking.id)).toBe(secondBefore);
  });
});
