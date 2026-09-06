import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeRateSnapshot } from '../src/domain/types.js';
import {
  BankAuthorityService,
  type BankDomainAdapter,
} from './bank-service.js';
import { canonicalJson } from './canonical-json.js';
import { createBotHttpServer, type ReadinessSnapshot } from './http-server.js';
import type { LogContext, ServiceLogger } from './logger.js';
import type { BankRateLimitRequest } from './rate-limit.js';
import { PreferencesRepository } from './repository.js';

const canonicalDigestObserver = vi.hoisted(() => vi.fn<(value: unknown) => void>());

vi.mock('./canonical-json.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-json.js')>();
  return {
    ...actual,
    canonicalJsonDigest(value: unknown): string {
      canonicalDigestObserver(value);
      return actual.canonicalJsonDigest(value);
    },
  };
});

const TOKEN = ['123456', 'synthetic_token_that_is_long_enough_for_tests'].join(':');
const NOW = 1_700_000_000;
const PUBLIC_URL = new URL('https://euphoria.bot/');

interface TestState {
  readonly primaryCurrency: 'KZT' | 'USD';
  readonly profile: { readonly telegramId: string; readonly displayName: string };
  readonly balanceMinor: number;
  readonly exchangeRates?: ExchangeRateSnapshot;
}

interface TestCommand {
  readonly kind: 'expense' | 'income';
  readonly amountMinor: number;
}

function parseTestState(value: unknown, expectedTelegramId: string): TestState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const profile = record.profile as Record<string, unknown> | undefined;
  const primaryCurrency = record.primaryCurrency ?? 'KZT';
  const displayName = profile?.displayName ?? 'Ada Lovelace';
  if (
    typeof record.profile !== 'object' ||
    record.profile === null ||
    Array.isArray(record.profile) ||
    (record.profile as Record<string, unknown>).telegramId !== expectedTelegramId ||
    (primaryCurrency !== 'KZT' && primaryCurrency !== 'USD') ||
    typeof displayName !== 'string' ||
    typeof record.balanceMinor !== 'number' ||
    !Number.isSafeInteger(record.balanceMinor) ||
    record.balanceMinor < 0
  ) {
    return null;
  }
  return {
    primaryCurrency,
    profile: { telegramId: expectedTelegramId, displayName },
    balanceMinor: record.balanceMinor,
    ...(record.exchangeRates === undefined
      ? {}
      : { exchangeRates: record.exchangeRates as ExchangeRateSnapshot }),
  };
}

const testBankDomain: BankDomainAdapter<TestState, TestCommand> = {
  parseState: (value, _nowISO, options) => parseTestState(value, options.expectedTelegramId),
  migrateImport: (value, _version, _nowISO, options) =>
    parseTestState(value, options.expectedTelegramId),
  serializeState: canonicalJson,
  parseCommand: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      (record.kind !== 'expense' && record.kind !== 'income') ||
      typeof record.amountMinor !== 'number' ||
      !Number.isSafeInteger(record.amountMinor) ||
      record.amountMinor <= 0 ||
      Object.keys(record).length !== 2
    ) {
      return null;
    }
    return { kind: record.kind, amountMinor: record.amountMinor };
  },
  commandKind: () => 'record_transaction',
  applyCommand: (state, command) => {
    if (command.kind === 'expense' && command.amountMinor > state.balanceMinor) {
      return {
        code: 'insufficient_funds',
        availableMinor: state.balanceMinor,
        requiredMinor: command.amountMinor,
      };
    }
    return {
      state: {
        ...state,
        balanceMinor: state.balanceMinor + (command.kind === 'expense' ? -1 : 1) * command.amountMinor,
      },
      warnings: [],
      outcome: {
        ok: true,
        applied: true,
        ...(command.kind === 'income' ? { incomingAmountMinor: command.amountMinor } : {}),
      },
    };
  },
  materialize: (state) => ({ state, warnings: [] }),
  replaceExchangeRates: (state, exchangeRates) => ({ ...state, exchangeRates }),
};

const TEST_RATES: ExchangeRateSnapshot = {
  base: 'USD',
  asOf: '2023-11-14',
  fetchedAt: '2023-11-14T22:13:20.000Z',
  source: 'frankfurter',
  rates: {
    USD: '1', EUR: '0.9', RUB: '90', KZT: '460',
    THB: '35', VND: '24000', IDR: '15000', GEL: '2.7',
  },
};

function signedInitData(authDate = NOW, userId = 42): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'query-1',
    user: JSON.stringify({
      id: userId,
      first_name: 'Ada',
      last_name: 'Lovelace',
      language_code: 'en',
    }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.append('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function postHeadersWithoutBody(
  baseUrl: string,
  pathname: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(new URL(pathname, baseUrl), {
      method: 'POST',
      headers,
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error('Server waited for the request body'));
    }, 2_000);
    request.on('response', (response) => {
      response.setEncoding('utf8');
      let responseBody = '';
      response.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.destroy();
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(responseBody) as unknown,
        });
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    request.flushHeaders();
  });
}

describe('bot HTTP service', () => {
  let repository: PreferencesRepository;
  let readiness: ReadinessSnapshot;
  let server: ReturnType<typeof createBotHttpServer>;
  let baseUrl: string;
  let errorLogs: Array<{ readonly event: string; readonly context?: LogContext }>;
  let bankService: BankAuthorityService<TestState, TestCommand>;
  let rateLimitRetry: number | null;
  let rateLimitRequests: BankRateLimitRequest[];
  let rateLimitObserver: (request: BankRateLimitRequest) => void;
  let rateLimitDecision: (request: BankRateLimitRequest) => number | null;
  let rateProviderGet: ReturnType<typeof vi.fn<() => Promise<ExchangeRateSnapshot>>>;

  beforeEach(async () => {
    repository = new PreferencesRepository(':memory:');
    readiness = { botSetup: true, polling: true, shuttingDown: false };
    errorLogs = [];
    rateLimitRetry = null;
    rateLimitRequests = [];
    rateLimitObserver = () => undefined;
    rateLimitDecision = () => rateLimitRetry;
    canonicalDigestObserver.mockReset();
    rateProviderGet = vi.fn(async () => TEST_RATES);
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (event, context) => errorLogs.push({ event, context }),
    };
    bankService = new BankAuthorityService(
      repository,
      testBankDomain,
      () => new Date(NOW * 1_000),
      { get: rateProviderGet },
    );
    server = createBotHttpServer({
      repository,
      botToken: TOKEN,
      publicWebAppUrl: PUBLIC_URL,
      readiness: () => readiness,
      nowSeconds: () => NOW,
      logger,
      bankService,
      bankRequestLimiter: {
        consume(request) {
          rateLimitObserver(request);
          rateLimitRequests.push(request);
          return rateLimitDecision(request);
        },
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    repository.close();
  });

  it('returns the strict bootstrap contract from validated initData', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL.origin);
    expect(await response.json()).toEqual({
      version: 1,
      revisionEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
      revision: 1,
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada Lovelace',
      telegramId: '42',
      onboardingComplete: false,
    });
    expect(rateLimitRequests).toEqual([{
      telegramUserId: '42',
      kind: 'bootstrap',
      sourceKind: 'tma',
      operationId: 'bootstrap',
      durableReplay: false,
      nowMs: NOW * 1_000,
    }]);
  });

  it.each([['local', false], ['server', true]] as const)(
    'rejects an exhausted bootstrap budget before %s preferences or bank lookup',
    async (_mode, serverMode) => {
      if (serverMode) repository.setLedgerMode('server');
      rateLimitRetry = 17;
      const bootstrap = vi.spyOn(bankService, 'bootstrap');

      const response = await fetch(`${baseUrl}/bootstrap`, {
        method: 'POST',
        headers: {
          authorization: `tma ${signedInitData()}`,
          'content-type': 'application/json',
          origin: PUBLIC_URL.origin,
        },
        body: '{}',
      });

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: 'rate_limited',
        details: { retryAfterSeconds: 17 },
      });
      expect(repository.getUser('42')).toBeNull();
      expect(bootstrap).not.toHaveBeenCalled();
      expect(rateLimitRequests).toEqual([expect.objectContaining({
        telegramUserId: '42',
        kind: 'bootstrap',
        durableReplay: false,
      })]);
    },
  );

  it('additively advertises import-required bank authority after the service flag switches', async () => {
    repository.setLedgerMode('server');
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      telegramId: '42',
      bank: {
        contractVersion: 1,
        mode: 'import_required',
        telegramId: '42',
      },
    });
  });

  it('imports and mutates only the HMAC-authenticated user with replay-safe responses', async () => {
    repository.setLedgerMode('server');
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };
    const importResponse = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        state: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }),
    });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json() as Record<string, unknown>;
    expect(imported).toMatchObject({
      version: 1,
      mode: 'server',
      telegramId: '42',
      revision: 1,
      imported: true,
      replayed: false,
      state: { balanceMinor: 1_000, profile: { telegramId: '42' } },
    });
    expect(imported.digest).toMatch(/^[0-9a-f]{64}$/);

    const commandBody = JSON.stringify({
      version: 1,
      clientMutationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      command: { kind: 'expense', amountMinor: 250 },
    });
    const appliedResponse = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: commandBody,
    });
    const replayResponse = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: commandBody,
    });
    expect(appliedResponse.status).toBe(200);
    expect(await appliedResponse.json()).toMatchObject({
      telegramId: '42',
      applied: true,
      replayed: false,
      operationRevision: 2,
      revision: 2,
      outcome: { ok: true, applied: true },
      state: { balanceMinor: 750 },
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      telegramId: '42',
      applied: true,
      replayed: true,
      operationRevision: 2,
      revision: 2,
      state: { balanceMinor: 750 },
    });
    expect(rateLimitRequests).toEqual([
      expect.objectContaining({ kind: 'import_ingress', durableReplay: false }),
      expect.objectContaining({ kind: 'import', durableReplay: false }),
      expect.objectContaining({ kind: 'command_ingress', durableReplay: false }),
      expect.objectContaining({ kind: 'command', durableReplay: false }),
      expect.objectContaining({ kind: 'command_ingress', durableReplay: false }),
      expect.objectContaining({ kind: 'command', durableReplay: true }),
    ]);
  });

  it('charges import ingress before body read and new-import budget before canonical hashing', async () => {
    repository.setLedgerMode('server');
    const events: string[] = [];
    const hasBankOperation = repository.hasBankOperation.bind(repository);
    const isExactBankOperation = repository.isExactBankOperation.bind(repository);
    vi.spyOn(repository, 'hasBankOperation').mockImplementation(
      (telegramUserId, sourceKind, operationId) => {
        events.push('repository:exists');
        return hasBankOperation(telegramUserId, sourceKind, operationId);
      },
    );
    vi.spyOn(repository, 'isExactBankOperation').mockImplementation(
      (telegramUserId, sourceKind, operationId, commandHash) => {
        events.push('repository:exact');
        return isExactBankOperation(telegramUserId, sourceKind, operationId, commandHash);
      },
    );
    canonicalDigestObserver.mockImplementation(() => events.push('digest'));
    rateLimitObserver = (request) => events.push(
      `rate:${request.kind}:${request.durableReplay ? 'replay' : 'charged'}`,
    );
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };
    const importId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const bodyFor = (balanceMinor: number) => JSON.stringify({
      version: 1,
      importId,
      stateVersion: 5,
      state: { profile: { telegramId: '42' }, balanceMinor },
    });

    const imported = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: bodyFor(1_000),
    });
    expect(imported.status).toBe(200);
    expect(events.slice(0, 4)).toEqual([
      'rate:import_ingress:charged',
      'repository:exists',
      'rate:import:charged',
      'digest',
    ]);

    events.length = 0;
    const replay = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: bodyFor(1_000),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(events.slice(0, 5)).toEqual([
      'rate:import_ingress:charged',
      'repository:exists',
      'digest',
      'repository:exact',
      'rate:import:replay',
    ]);

    events.length = 0;
    const conflict = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: bodyFor(1_001),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'idempotency_conflict' });
    expect(events.slice(0, 5)).toEqual([
      'rate:import_ingress:charged',
      'repository:exists',
      'digest',
      'repository:exact',
      'rate:import:charged',
    ]);
  });

  it('rejects a fresh import budget before canonical hashing or SQLite state creation', async () => {
    repository.setLedgerMode('server');
    rateLimitDecision = (request) => request.kind === 'import' ? 23 : null;
    const importState = vi.spyOn(bankService, 'importState');

    const response = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: JSON.stringify({
        version: 1,
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        state: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'rate_limited',
      details: { retryAfterSeconds: 23 },
    });
    expect(rateLimitRequests.map(({ kind }) => kind)).toEqual(['import_ingress', 'import']);
    expect(canonicalDigestObserver).not.toHaveBeenCalled();
    expect(importState).not.toHaveBeenCalled();
    expect(repository.getUser('42')).toBeNull();
    expect(repository.getBankState('42')).toBeNull();
  });

  it('rejects unauthenticated or ingress-limited imports without reading their body', async () => {
    const hasBankOperation = vi.spyOn(repository, 'hasBankOperation');
    const headers = {
      'content-type': 'application/json',
      'content-length': String(4 * 1024 * 1024),
      origin: PUBLIC_URL.origin,
    };

    const unauthenticated = await postHeadersWithoutBody(baseUrl, '/bank-import', {
      ...headers,
      authorization: 'tma invalid',
    });
    expect(unauthenticated).toEqual({ status: 401, body: { error: 'invalid_init_data' } });
    expect(rateLimitRequests).toEqual([]);
    expect(canonicalDigestObserver).not.toHaveBeenCalled();
    expect(hasBankOperation).not.toHaveBeenCalled();

    rateLimitRetry = 19;
    const limited = await postHeadersWithoutBody(baseUrl, '/bank-import', {
      ...headers,
      authorization: `tma ${signedInitData()}`,
    });
    expect(limited).toEqual({
      status: 429,
      body: { error: 'rate_limited', details: { retryAfterSeconds: 19 } },
    });
    expect(rateLimitRequests).toEqual([{
      telegramUserId: '42',
      kind: 'import_ingress',
      sourceKind: 'tma',
      operationId: 'import_ingress',
      durableReplay: false,
      nowMs: NOW * 1_000,
    }]);
    expect(canonicalDigestObserver).not.toHaveBeenCalled();
    expect(hasBankOperation).not.toHaveBeenCalled();
  });

  it.each(['/bootstrap', '/bank-command', '/bank-rates'])(
    'authenticates %s before content type or body validation',
    async (pathname) => {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          authorization: 'tma invalid',
          'content-type': 'text/plain',
          origin: PUBLIC_URL.origin,
        },
        body: 'not-json',
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_init_data' });
      expect(rateLimitRequests).toEqual([]);
    },
  );

  it('rejects an exhausted command ingress budget before reading or hashing the body', async () => {
    rateLimitDecision = (request) => request.kind === 'command_ingress' ? 19 : null;
    const exactOperation = vi.spyOn(repository, 'isExactBankOperation');
    const response = await postHeadersWithoutBody(baseUrl, '/bank-command', {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      'content-length': String(64 * 1024),
      origin: PUBLIC_URL.origin,
    });

    expect(response).toEqual({
      status: 429,
      body: { error: 'rate_limited', details: { retryAfterSeconds: 19 } },
    });
    expect(rateLimitRequests).toEqual([{
      telegramUserId: '42',
      kind: 'command_ingress',
      sourceKind: 'tma',
      operationId: 'command_ingress',
      durableReplay: false,
      nowMs: NOW * 1_000,
    }]);
    expect(canonicalDigestObserver).not.toHaveBeenCalled();
    expect(exactOperation).not.toHaveBeenCalled();
  });

  it('charges command ingress before malformed JSON and canonical-depth rejection', async () => {
    const events: string[] = [];
    rateLimitObserver = (request) => events.push(`rate:${request.kind}`);
    canonicalDigestObserver.mockImplementation(() => events.push('digest'));
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };

    const malformed = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_json' });
    expect(events).toEqual(['rate:command_ingress']);

    events.length = 0;
    const nestedCommand = `${'{"next":'.repeat(66)}0${'}'.repeat(66)}`;
    const tooDeep = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: `{"version":1,"clientMutationId":"${'a'.repeat(32)}","command":${nestedCommand}}`,
    });
    expect(tooDeep.status).toBe(400);
    expect(await tooDeep.json()).toEqual({ error: 'invalid_body' });
    expect(events).toEqual(['rate:command_ingress', 'digest']);
    expect(rateLimitRequests.map(({ kind }) => kind)).toEqual([
      'command_ingress',
      'command_ingress',
    ]);
  });

  it('projects primary currency and display name from canonical BankState in server mode', async () => {
    repository.setLedgerMode('server');
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };
    const imported = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        state: {
          primaryCurrency: 'USD',
          profile: { telegramId: '42', displayName: 'Canonical Ada' },
          balanceMinor: 1_000,
        },
      }),
    });
    expect(imported.status).toBe(200);

    const bootstrap = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      telegramId: '42',
      primaryCurrency: 'USD',
      displayName: 'Canonical Ada',
      bank: {
        mode: 'server',
        telegramId: '42',
        state: {
          primaryCurrency: 'USD',
          profile: { telegramId: '42', displayName: 'Canonical Ada' },
        },
      },
    });
  });

  it('returns typed overdraft and idempotency errors without leaking or changing state', async () => {
    repository.setLedgerMode('server');
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };
    await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        state: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }),
    });
    const rejected = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        command: { kind: 'expense', amountMinor: 1_001 },
      }),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({
      error: 'insufficient_funds',
      details: { availableMinor: 1_000, requiredMinor: 1_001 },
    });
    expect(repository.getBankState('42')).toMatchObject({ revision: 1 });

    const first = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'cccccccccccccccccccccccccccccccc',
        command: { kind: 'expense', amountMinor: 100 },
      }),
    });
    expect(first.status).toBe(200);
    const collision = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'cccccccccccccccccccccccccccccccc',
        command: { kind: 'expense', amountMinor: 101 },
      }),
    });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: 'idempotency_conflict' });
    expect(repository.getBankState('42')).toMatchObject({
      revision: 2,
      state: { balanceMinor: 900 },
    });
    expect(errorLogs).toEqual([]);
  });

  it('rate-limits an authenticated bank mutation before creating its SQLite user', async () => {
    repository.setLedgerMode('server');
    rateLimitDecision = (request) => request.kind === 'command' ? 17 : null;
    const response = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        command: { kind: 'income', amountMinor: 1 },
      }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'rate_limited',
      details: { retryAfterSeconds: 17 },
    });
    expect(rateLimitRequests).toEqual([
      expect.objectContaining({
        telegramUserId: '42',
        kind: 'command_ingress',
        durableReplay: false,
      }),
      {
        telegramUserId: '42',
        kind: 'command',
        sourceKind: 'tma',
        operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        replayFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        durableReplay: false,
        nowMs: NOW * 1_000,
      },
    ]);
    expect(repository.getUser('42')).toBeNull();
  });

  it('keeps two authenticated Telegram users in separate server ledgers', async () => {
    repository.setLedgerMode('server');
    const importFor = async (userId: number, balanceMinor: number, importId: string) => {
      const response = await fetch(`${baseUrl}/bank-import`, {
        method: 'POST',
        headers: {
          authorization: `tma ${signedInitData(NOW, userId)}`,
          'content-type': 'application/json',
          origin: PUBLIC_URL.origin,
        },
        body: JSON.stringify({
          version: 1,
          importId,
          stateVersion: 5,
          state: { profile: { telegramId: String(userId) }, balanceMinor },
        }),
      });
      expect(response.status).toBe(200);
    };
    await importFor(42, 1_000, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await importFor(43, 2_000, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const changed = await fetch(`${baseUrl}/bank-command`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData(NOW, 42)}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'cccccccccccccccccccccccccccccccc',
        command: { kind: 'expense', amountMinor: 100 },
      }),
    });
    expect(changed.status).toBe(200);
    expect(repository.getBankState('42')?.state).toMatchObject({ balanceMinor: 900 });
    expect(repository.getBankState('43')?.state).toMatchObject({ balanceMinor: 2_000 });
  });

  it('refreshes only the authenticated canonical ledger through the server provider', async () => {
    repository.setLedgerMode('server');
    const importFor = async (userId: number, importId: string) => {
      const response = await fetch(`${baseUrl}/bank-import`, {
        method: 'POST',
        headers: {
          authorization: `tma ${signedInitData(NOW, userId)}`,
          'content-type': 'application/json',
          origin: PUBLIC_URL.origin,
        },
        body: JSON.stringify({
          version: 1,
          importId,
          stateVersion: 5,
          state: { profile: { telegramId: String(userId) }, balanceMinor: 1_000 },
        }),
      });
      expect(response.status).toBe(200);
    };
    await importFor(42, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await importFor(43, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const response = await fetch(`${baseUrl}/bank-rates`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'cccccccccccccccccccccccccccccccc',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      mode: 'server',
      telegramId: '42',
      updated: true,
      revision: 2,
      state: { exchangeRates: TEST_RATES },
    });
    expect(repository.getBankState('42')).toMatchObject({
      revision: 2,
      state: { exchangeRates: TEST_RATES },
    });
    expect(repository.getBankState('43')?.state).not.toHaveProperty('exchangeRates');
    expect(rateProviderGet).toHaveBeenCalledOnce();
    expect(rateLimitRequests.at(-1)).toEqual({
      telegramUserId: '42',
      kind: 'rates',
      sourceKind: 'tma',
      operationId: 'cccccccccccccccccccccccccccccccc',
      durableReplay: false,
      nowMs: NOW * 1_000,
    });
  });

  it('fails the rate boundary closed for invalid auth, origin, body, and provider errors', async () => {
    repository.setLedgerMode('server');
    const headers = {
      authorization: `tma ${signedInitData()}`,
      'content-type': 'application/json',
      origin: PUBLIC_URL.origin,
    };
    const imported = await fetch(`${baseUrl}/bank-import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        state: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }),
    });
    expect(imported.status).toBe(200);

    const body = JSON.stringify({
      version: 1,
      clientMutationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    const invalidAuth = await fetch(`${baseUrl}/bank-rates`, {
      method: 'POST',
      headers: { ...headers, authorization: 'tma invalid' },
      body,
    });
    const invalidOrigin = await fetch(`${baseUrl}/bank-rates`, {
      method: 'POST',
      headers: { ...headers, origin: 'https://attacker.invalid' },
      body,
    });
    const invalidBody = await fetch(`${baseUrl}/bank-rates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        clientMutationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rates: TEST_RATES,
      }),
    });
    expect(invalidAuth.status).toBe(401);
    expect(invalidOrigin.status).toBe(403);
    expect(invalidBody.status).toBe(400);

    rateProviderGet.mockRejectedValueOnce(new TypeError('private provider failure'));
    const failure = await fetch(`${baseUrl}/bank-rates`, {
      method: 'POST',
      headers,
      body,
    });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: 'bank_rates_unavailable' });
    expect(repository.getBankState('42')).toMatchObject({ revision: 1 });
    expect(errorLogs).toEqual([]);
  });

  it('rejects a wrong origin without reflecting it', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: 'https://attacker.invalid',
      },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
    expect(errorLogs).toEqual([]);
  });

  it('requires JSON, an empty object body, and a bounded payload', async () => {
    const authorization = `tma ${signedInitData()}`;
    const wrongType = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'text/plain', origin: PUBLIC_URL.origin },
      body: '{}',
    });
    const wrongShape = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', origin: PUBLIC_URL.origin },
      body: '{"unexpected":true}',
    });
    const oversized = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', origin: PUBLIC_URL.origin },
      body: JSON.stringify({ padding: 'x'.repeat(1_100) }),
    });

    expect(wrongType.status).toBe(415);
    expect(wrongShape.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it('maps missing, invalid, and stale authorization to one non-oracular response', async () => {
    const headers = { 'content-type': 'application/json', origin: PUBLIC_URL.origin };
    const missing = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const invalid = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { ...headers, authorization: `tma ${signedInitData()}x` },
      body: '{}',
    });
    const stale = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { ...headers, authorization: `tma ${signedInitData(NOW - 86_401)}` },
      body: '{}',
    });

    for (const response of [missing, invalid, stale]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_init_data' });
    }
    expect(rateLimitRequests).toEqual([]);
  });

  it('reports readiness without exposing configuration or secrets', async () => {
    readiness = { botSetup: false, polling: false, shuttingDown: false };
    const starting = await fetch(`${baseUrl}/healthz`);
    const startingBody = await starting.text();
    expect(starting.status).toBe(503);
    expect(startingBody).not.toContain(TOKEN);
    expect(startingBody).not.toContain('euphoria.bot');

    readiness = { botSetup: true, polling: true, shuttingDown: false };
    const ready = await fetch(`${baseUrl}/healthz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', ready: true });
  });

  it('answers same-origin CORS preflight with the narrow method and headers', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'OPTIONS',
      headers: { origin: PUBLIC_URL.origin },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL.origin);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST');
    expect(response.headers.get('access-control-allow-headers'))
      .toBe('authorization, content-type');
  });

  it('logs only safe metadata for an unexpected bootstrap failure', async () => {
    const authorization = `tma ${signedInitData()}`;
    const privateErrorText = `repository failure containing ${TOKEN}`;
    const ensureUser = repository.ensureUser.bind(repository);
    repository.ensureUser = () => {
      const error = new Error(privateErrorText);
      error.name = authorization;
      throw error;
    };
    try {
      const response = await fetch(`${baseUrl}/bootstrap`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          origin: PUBLIC_URL.origin,
        },
        body: '{}',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal_error' });
      expect(errorLogs).toEqual([{
        event: 'bot_http_request_failed',
        context: {
          method: 'POST',
          route: '/bootstrap',
          errorType: 'Error',
        },
      }]);
      const serializedLogs = JSON.stringify(errorLogs);
      expect(serializedLogs).not.toContain(authorization);
      expect(serializedLogs).not.toContain(TOKEN);
      expect(serializedLogs).not.toContain(privateErrorText);
    } finally {
      repository.ensureUser = ensureUser;
    }
  });
});
