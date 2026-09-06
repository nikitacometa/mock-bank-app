import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BankCommand } from '../src/domain/bankCommands.js';
import { parseBankState } from '../src/domain/bankState.js';
import { assertLedger } from '../src/domain/invariants.js';
import { balanceOf } from '../src/domain/ledger.js';
import { buildSeed } from '../src/domain/seed.js';
import type { BankState, Currency } from '../src/domain/types.js';
import { bankDomainAdapter } from './bank-domain.js';
import { BankAuthorityService } from './bank-service.js';
import { createBotHttpServer } from './http-server.js';
import type { TelegramUserIdentity } from './model.js';
import { OnboardingEngine } from './onboarding.js';
import { InMemoryBankRequestLimiter } from './rate-limit.js';
import { PreferencesRepository } from './repository.js';
import type { BotTransport, SendMessageInput, TelegramUpdate } from './telegram.js';

// Only the Telegram network boundary is substituted. Domain, authentication,
// conversations, rate limits, HTTP, and file-backed SQLite are production code.
const TOKEN = ['123456', 'synthetic_end_to_end_token_for_tests_only'].join(':');
const PUBLIC_URL = new URL('https://euphoria.bot/');
const ADA = { id: '42', firstName: 'Ada', lastName: 'Lovelace', languageCode: 'en' };
const GRACE = { id: '43', firstName: 'Grace', lastName: 'Hopper', languageCode: 'en' };

class CapturingTransport implements BotTransport {
  readonly sent: SendMessageInput[] = [];

  async sendMessage(input: SendMessageInput): Promise<void> { this.sent.push(input); }
  async answerCallbackQuery(): Promise<void> {}
  async setUserMenuButton(): Promise<void> {}

  last(identity: TelegramUserIdentity): SendMessageInput {
    const message = this.sent.findLast((item) => item.chatId === identity.id);
    if (message === undefined) throw new Error(`No bot response for ${identity.id}`);
    return message;
  }

  button(identity: TelegramUserIdentity, match: (text: string, data: string) => boolean): string {
    const button = this.last(identity).replyMarkup?.inline_keyboard.flat().find((item) =>
      'callback_data' in item && match(item.text, item.callback_data));
    if (button === undefined || !('callback_data' in button)) {
      throw new Error(`Missing expected bot button for ${identity.id}`);
    }
    return button.callback_data;
  }
}

function signedInitData(identity: TelegramUserIdentity, nowISO: string): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.parse(nowISO) / 1_000)),
    query_id: `integration-${identity.id}`,
    user: JSON.stringify({
      id: Number(identity.id), first_name: identity.firstName,
      last_name: identity.lastName, language_code: identity.languageCode,
    }),
  });
  const check = [...params.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.append('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

interface Snapshot {
  readonly state: BankState;
  readonly revision: number;
  readonly digest: string;
  readonly revisionEpoch: string;
}

describe('real Telegram bot ↔ authenticated HTTP ↔ durable bank ledger', () => {
  let directory: string;
  let repository: PreferencesRepository;
  let server: Server;
  let engine: OnboardingEngine;
  let transport: CapturingTransport;
  let baseUrl: string;
  let nowISO: string;
  let updateId: number;
  let mutationId: number;
  let errors: string[];

  async function open(): Promise<void> {
    repository = new PreferencesRepository(join(directory, 'bank.sqlite'), () => new Date(nowISO));
    const service = new BankAuthorityService(repository, bankDomainAdapter, () => new Date(nowISO));
    const limiter = new InMemoryBankRequestLimiter();
    transport = new CapturingTransport();
    engine = new OnboardingEngine(repository, transport, PUBLIC_URL,
      { warn: () => undefined }, async () => undefined, () => Date.parse(nowISO), service, limiter);
    server = createBotHttpServer({
      repository, botToken: TOKEN, publicWebAppUrl: PUBLIC_URL, bankService: service,
      bankRequestLimiter: limiter,
      readiness: () => ({ botSetup: true, polling: true, shuttingDown: false }),
      nowSeconds: () => Math.floor(Date.parse(nowISO) / 1_000),
      logger: { info: () => undefined, warn: () => undefined, error: (event) => errors.push(event) },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    });
    repository.close();
  }

  async function restart(): Promise<void> { await close(); await open(); }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cometa-real-e2e-'));
    nowISO = '2026-09-05T12:00:00.000Z';
    updateId = 1;
    mutationId = 1;
    errors = [];
    await open();
    repository.setLedgerMode('server');
  });

  afterEach(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
    expect(errors).toEqual([]);
  });

  async function post(identity: TelegramUserIdentity, route: string, body: object): Promise<{
    readonly status: number; readonly body: Record<string, unknown>;
  }> {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData(identity, nowISO)}`,
        'content-type': 'application/json', origin: PUBLIC_URL.origin,
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async function snapshot(identity: TelegramUserIdentity): Promise<Snapshot> {
    const response = await post(identity, '/bootstrap', {});
    expect(response.status).toBe(200);
    expect(response.body.telegramId).toBe(identity.id);
    const bank = response.body.bank as Record<string, unknown>;
    expect(bank).toMatchObject({ mode: 'server', telegramId: identity.id });
    const state = parseBankState(bank.state, nowISO, { expectedTelegramId: identity.id });
    if (state === null) throw new Error('HTTP returned an invalid canonical bank state');
    assertLedger(state);
    expect(bank.revision).toEqual(expect.any(Number));
    expect(bank.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(bank.revisionEpoch).toMatch(/^[0-9a-f]{32}$/);
    return { state, revision: bank.revision as number, digest: bank.digest as string,
      revisionEpoch: bank.revisionEpoch as string };
  }

  async function message(identity: TelegramUserIdentity, text: string): Promise<void> {
    const id = updateId++;
    await engine.handleUpdate({ updateId: id, message: {
      messageId: id, chat: { id: identity.id, type: 'private' }, from: identity, text,
    } });
  }

  async function callback(identity: TelegramUserIdentity, data: string): Promise<TelegramUpdate> {
    const id = updateId++;
    const update: TelegramUpdate = { updateId: id, callbackQuery: {
      id: `e2e-${id}`, from: identity, data,
      message: { messageId: id, chat: { id: identity.id, type: 'private' } },
    } };
    await engine.handleUpdate(update);
    return update;
  }

  async function action(identity: TelegramUserIdentity, name: string, argument?: string): Promise<TelegramUpdate> {
    const suffix = argument === undefined ? `:${name}` : `:${name}:${argument}`;
    return callback(identity, transport.button(identity, (_text, data) => data.endsWith(suffix)));
  }

  async function textButton(identity: TelegramUserIdentity, text: string): Promise<void> {
    await callback(identity, transport.button(identity, (label) => label.includes(text)));
  }

  async function onboard(identity: TelegramUserIdentity, currency: Currency = 'KZT'): Promise<BankState> {
    await message(identity, '/start');
    await callback(identity, 'lang:en');
    await callback(identity, `currency:${currency}`);
    expect(repository.getUser(identity.id)).toMatchObject({ stage: 'complete', primaryCurrency: currency });
    const bootstrap = await post(identity, '/bootstrap', {});
    expect(bootstrap.body.bank).toMatchObject({ mode: 'import_required', telegramId: identity.id });
    const state: BankState = { ...buildSeed(nowISO, currency),
      profile: { telegramId: identity.id, displayName: `${identity.firstName} ${identity.lastName}` } };
    const imported = await post(identity, '/bank-import', {
      version: 1, importId: 'a'.repeat(32), stateVersion: 5, state,
    });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: true, replayed: false, telegramId: identity.id });
    return state;
  }

  async function transactionDetails(identity: TelegramUserIdentity,
    direction: 'income' | 'expense', amount: string, counterparty: string): Promise<void> {
    await message(identity, '/add');
    await action(identity, 'td', direction === 'expense' ? 'e' : 'i');
    await action(identity, 'ac', '0');
    await message(identity, amount);
    await message(identity, counterparty);
    await message(identity, 'E2E integration');
  }

  async function oneShot(identity: TelegramUserIdentity,
    direction: 'income' | 'expense', amount: string, counterparty: string): Promise<TelegramUpdate> {
    await transactionDetails(identity, direction, amount, counterparty);
    await action(identity, 'co');
    await action(identity, 'dt');
    return action(identity, 'cf');
  }

  async function command(identity: TelegramUserIdentity, value: BankCommand,
    clientMutationId = (mutationId++).toString(16).padStart(32, '0')): Promise<Awaited<ReturnType<typeof post>>> {
    return post(identity, '/bank-command', { version: 1, clientMutationId, command: value });
  }

  it('keeps two signed users isolated and preserves exact bot/API transactions and replay receipts across a SQLite restart', async () => {
    const adaDevice = await onboard(ADA);
    await onboard(GRACE, 'THB');
    const before = await snapshot(ADA);
    const graceBefore = await snapshot(GRACE);
    const checking = before.state.accounts.find((account) => account.role === 'primary-checking')!;
    const startingBalance = balanceOf(before.state, checking.id);

    const confirmed = await oneShot(ADA, 'expense', '1234.56', 'Spotify E2E');
    const afterExpense = await snapshot(ADA);
    expect(balanceOf(afterExpense.state, checking.id)).toBe(startingBalance - 123_456);
    expect(afterExpense.state.transactions.filter((item) => item.counterparty === 'Spotify E2E'))
      .toEqual([expect.objectContaining({ kind: 'manual_expense', amountMinor: -123_456,
        effectiveDate: '2026-09-05', note: 'E2E integration' })]);
    await engine.handleUpdate(confirmed);
    expect(await snapshot(ADA)).toEqual(afterExpense);

    await oneShot(ADA, 'income', '500.25', 'Client invoice E2E');
    const expense: BankCommand = { kind: 'record_transaction', accountId: checking.id,
      direction: 'expense', amountInput: '0.01', locale: 'en', counterparty: 'HTTP coffee E2E',
      effectiveDate: '2026-09-05' };
    const id = 'b'.repeat(32);
    const applied = await command(ADA, expense, id);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, replayed: false });
    const saved = await snapshot(ADA);
    expect(balanceOf(saved.state, checking.id)).toBe(startingBalance - 123_456 + 50_025 - 1);
    expect(await snapshot(GRACE)).toEqual(graceBefore);

    // The same mutation key belongs independently to each authenticated user.
    const graceChecking = graceBefore.state.accounts.find((account) => account.role === 'primary-checking')!;
    const graceApplied = await command(GRACE, { ...expense, accountId: graceChecking.id,
      counterparty: 'Grace coffee E2E' }, id);
    expect(graceApplied.status).toBe(200);
    expect(graceApplied.body).toMatchObject({ replayed: false, telegramId: GRACE.id });
    const graceSaved = await snapshot(GRACE);
    expect(balanceOf(graceSaved.state, graceChecking.id))
      .toBe(balanceOf(graceBefore.state, graceChecking.id) - 1);

    const overwrite = await post(ADA, '/bank-import', {
      version: 1, importId: 'c'.repeat(32), stateVersion: 5, state: adaDevice,
    });
    expect(overwrite).toMatchObject({ status: 409, body: { error: 'bank_already_exists' } });
    expect(await snapshot(ADA)).toEqual(saved);
    const crossIdentity = await post(GRACE, '/bank-import', {
      version: 1, importId: 'd'.repeat(32), stateVersion: 5, state: adaDevice,
    });
    expect(crossIdentity).toMatchObject({ status: 422, body: { error: 'invalid_bank_state' } });

    await restart();
    expect(repository.ledgerMode()).toBe('server');
    expect(await snapshot(ADA)).toEqual(saved);
    expect(await snapshot(GRACE)).toEqual(graceSaved);
    const replay = await command(ADA, expense, id);
    expect(replay).toMatchObject({ status: 200, body: { replayed: true,
      operationRevision: applied.body.operationRevision, digest: saved.digest } });
    await engine.handleUpdate(confirmed);
    expect(await snapshot(ADA)).toEqual(saved);
    await message(ADA, '/start');
    expect(transport.last(ADA).text).toContain('Ada Lovelace');
    expect(transport.last(ADA).replyMarkup?.inline_keyboard.flat())
      .toContainEqual(expect.objectContaining({ web_app: { url: PUBLIC_URL.href } }));
  });

  it('shares account creation, adjustment and reversible closure from chat with HTTP without deleting history or another user data', async () => {
    await onboard(ADA);
    await onboard(GRACE);
    const graceBefore = await snapshot(GRACE);
    await message(ADA, '/accounts');
    await action(ADA, 'aa');
    await textButton(ADA, 'THB');
    await action(ADA, 'cf');
    const opened = await snapshot(ADA);
    const account = opened.state.accounts.find((item) => item.currency === 'THB')!;
    expect(account).toMatchObject({ type: 'checking', role: 'custom', status: 'active' });
    expect(balanceOf(opened.state, account.id)).toBe(0);

    for (const target of ['1000.25', '0']) {
      // Wizard steps are intentionally serialized: every callback uses the
      // durable conversation revision produced by the preceding response.
      await message(ADA, '/accounts');
      await textButton(ADA, 'THB');
      await action(ADA, 'aj');
      await message(ADA, target);
      await action(ADA, 'cf');
      expect(balanceOf((await snapshot(ADA)).state, account.id)).toBe(target === '0' ? 0 : 100_025);
    }
    const zero = await snapshot(ADA);
    const accountRows = zero.state.transactions.filter((item) => item.accountId === account.id);
    expect(accountRows.map((item) => item.amountMinor)).toEqual([0, 100_025, -100_025]);
    await message(ADA, '/accounts');
    await textButton(ADA, 'THB');
    await action(ADA, 'cl');
    await action(ADA, 'cf');
    const closed = await snapshot(ADA);
    expect(closed.state.accounts.find((item) => item.id === account.id)?.status).toBe('closed');
    expect(closed.state.transactions).toEqual(zero.state.transactions);

    await restart();
    expect(await snapshot(ADA)).toEqual(closed);
    await message(ADA, '/accounts');
    await textButton(ADA, 'THB');
    await action(ADA, 'rs');
    await action(ADA, 'cf');
    const restored = await snapshot(ADA);
    expect(restored.state.accounts.find((item) => item.id === account.id)?.status).toBe('active');
    expect(restored.state.transactions).toEqual(zero.state.transactions);
    expect(await snapshot(GRACE)).toEqual(graceBefore);
  });

  it('backfills UTC recurrence atomically, rejects an overdraft, and materializes a due month exactly once after restart', async () => {
    await onboard(ADA);
    const before = await snapshot(ADA);
    const checking = before.state.accounts.find((account) => account.role === 'primary-checking')!;
    await transactionDetails(ADA, 'expense', '10.00', 'Spotify monthly E2E');
    await action(ADA, 'cm');
    await action(ADA, 'yr', '2026');
    await action(ADA, 'mo', '1');
    await action(ADA, 'da', '5');
    expect(transport.last(ADA).text).toContain('Backfill through Sep 5, 2026: <b>9</b> entries');
    const confirmed = await action(ADA, 'cf');
    const backfilled = await snapshot(ADA);
    const rule = backfilled.state.recurringRules[0]!;
    const rows = backfilled.state.transactions.filter((item) => item.recurringRuleId === rule.id);
    expect(rows.map((item) => item.effectiveDate))
      .toEqual(Array.from({ length: 9 }, (_, month) => `2026-${String(month + 1).padStart(2, '0')}-05`));
    expect(rows.every((item) => item.amountMinor === -1_000)).toBe(true);
    expect(balanceOf(backfilled.state, checking.id)).toBe(balanceOf(before.state, checking.id) - 9_000);

    const overdraftAmount = String(Math.floor(balanceOf(backfilled.state, checking.id) / 100) + 1);
    await transactionDetails(ADA, 'expense', overdraftAmount, 'Rejected expense E2E');
    await action(ADA, 'co');
    await action(ADA, 'dt');
    expect(transport.last(ADA).text).toContain('This would overdraw the account');
    expect(await snapshot(ADA)).toEqual(backfilled);

    const rejected = await command(ADA, { kind: 'create_recurring', ruleId: 'rr_e2e_rejected',
      accountId: checking.id, direction: 'expense', amountInput: overdraftAmount, locale: 'en',
      counterparty: 'Rejected backfill E2E', startYear: 2026, startMonth: 1, anchorDay: 5 });
    expect(rejected).toMatchObject({ status: 422, body: { error: 'insufficient_funds' } });
    expect(await snapshot(ADA)).toEqual(backfilled);

    nowISO = '2026-10-05T00:00:00.000Z';
    await restart();
    const due = await snapshot(ADA);
    expect(due.state.transactions.filter((item) => item.recurringRuleId === rule.id)).toHaveLength(10);
    expect(due.state.transactions.filter((item) => item.recurringRuleId === rule.id).at(-1))
      .toMatchObject({ effectiveDate: '2026-10-05', amountMinor: -1_000 });
    expect(balanceOf(due.state, checking.id)).toBe(balanceOf(backfilled.state, checking.id) - 1_000);
    expect(due.revision).toBeGreaterThan(backfilled.revision);
    expect(await snapshot(ADA)).toEqual(due);
    await engine.handleUpdate(confirmed);
    await message(ADA, '/start');
    expect(await snapshot(ADA)).toEqual(due);
    await restart();
    expect(await snapshot(ADA)).toEqual(due);
  });
});
