import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import {
  BankAuthorityService,
  BankServiceError,
  type BankDomainAdapter,
  type BankDomainCommandResult,
  type BankDomainFailure,
} from './bank-service.js';
import {
  BankOperationCapacityError,
  BankStateCapacityError,
  MAX_BANK_STATE_JSON_BYTES,
  PreferencesRepository,
} from './repository.js';

interface TestState {
  readonly primaryCurrency: 'KZT' | 'USD';
  readonly profile: { readonly telegramId: string; readonly displayName: string };
  readonly balanceMinor: number;
  readonly due?: boolean;
  readonly padding?: string;
}

type TestCommand =
  | { readonly kind: 'expense' | 'income'; readonly amountMinor: number }
  | { readonly kind: 'reset_demo' };

function parseTestState(value: unknown, expectedTelegramId: string): TestState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const profile = record.profile;
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return null;
  const telegramId = (profile as Record<string, unknown>).telegramId;
  const displayName = (profile as Record<string, unknown>).displayName ?? 'Ada';
  const primaryCurrency = record.primaryCurrency ?? 'KZT';
  if (
    telegramId !== expectedTelegramId ||
    typeof displayName !== 'string' ||
    (primaryCurrency !== 'KZT' && primaryCurrency !== 'USD') ||
    typeof record.balanceMinor !== 'number' ||
    !Number.isSafeInteger(record.balanceMinor) ||
    record.balanceMinor < 0 ||
    (record.due !== undefined && typeof record.due !== 'boolean') ||
    (record.padding !== undefined && typeof record.padding !== 'string')
  ) {
    return null;
  }
  return {
    primaryCurrency,
    profile: { telegramId, displayName },
    balanceMinor: record.balanceMinor,
    ...(record.due === undefined ? {} : { due: record.due }),
    ...(record.padding === undefined ? {} : { padding: record.padding }),
  };
}

const domain: BankDomainAdapter<TestState, TestCommand> = {
  parseState: (value, _nowISO, options) => parseTestState(value, options.expectedTelegramId),
  migrateImport: (value, _version, _nowISO, options) =>
    parseTestState(value, options.expectedTelegramId),
  serializeState: canonicalJson,
  parseCommand: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === 'reset_demo' && Object.keys(record).length === 1) {
      return { kind: 'reset_demo' };
    }
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
  commandKind: (command) => command.kind === 'reset_demo' ? 'reset_demo' : 'record_transaction',
  applyCommand: (state, command): BankDomainCommandResult<TestState> | BankDomainFailure => {
    if (command.kind === 'reset_demo') {
      return {
        state: { ...state, balanceMinor: 100, due: false },
        warnings: [],
        outcome: { ok: true, applied: true },
      };
    }
    if (command.kind === 'expense' && command.amountMinor > state.balanceMinor) {
      return {
        code: 'insufficient_funds',
        availableMinor: state.balanceMinor,
        requiredMinor: command.amountMinor,
      };
    }
    const sign = command.kind === 'expense' ? -1 : 1;
    return {
      state: { ...state, balanceMinor: state.balanceMinor + sign * command.amountMinor },
      warnings: [],
      outcome: {
        ok: true,
        applied: true,
        ...(command.kind === 'income' ? { incomingAmountMinor: command.amountMinor } : {}),
      },
    };
  },
  materialize: (state) => state.due === true
    ? {
        state: {
          ...state,
          balanceMinor: state.balanceMinor + 25,
          due: false,
          ...(state.padding === undefined ? {} : { padding: `${state.padding}${'x'.repeat(512)}` }),
        },
        warnings: [{ code: 'income_materialized' }],
      }
    : { state, warnings: [] },
};

function createService(id = '42') {
  const repository = new PreferencesRepository(':memory:');
  repository.ensureUser({
    telegramUserId: id,
    locale: 'en',
    primaryCurrency: 'KZT',
    displayName: 'Ada',
  });
  const service = new BankAuthorityService(repository, domain, () => new Date(1_700_000_000_000));
  return { repository, service };
}

function expectServiceError(
  work: () => unknown,
  expected: Readonly<Record<string, unknown>>,
): void {
  try {
    work();
    throw new Error('Expected BankServiceError');
  } catch (error) {
    expect(error).toBeInstanceOf(BankServiceError);
    expect(error).toMatchObject(expected);
  }
}

describe('BankAuthorityService', () => {
  it('keeps the bridge local until activation, then requires a per-user import', () => {
    const { repository, service } = createService();
    try {
      expect(service.bootstrap('42')).toBeNull();
      repository.setLedgerMode('server');
      expect(service.bootstrap('42')).toEqual({
        contractVersion: 1,
        mode: 'import_required',
        telegramId: '42',
      });
    } finally {
      repository.close();
    }
  });

  it('strictly imports the authenticated user once and replays the same import ID', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      const input = {
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5 as const,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      };
      const first = service.importState(input);
      const replay = service.importState(input);
      expect(first).toMatchObject({
        version: 1,
        mode: 'server',
        telegramId: '42',
        revision: 1,
        imported: true,
        replayed: false,
      });
      expect(replay).toMatchObject({ imported: false, replayed: true, revision: 1 });
      expect(replay.digest).toBe(first.digest);

      expectServiceError(() => service.importState({
        ...input,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 999 },
      }), { status: 409, code: 'idempotency_conflict' });
      expectServiceError(() => service.importState({
        ...input,
        importId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }), { status: 409, code: 'bank_already_exists' });
    } finally {
      repository.close();
    }
  });

  it('rejects a state for another Telegram user before repository insertion', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      expectServiceError(() => service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 4,
        rawState: { profile: { telegramId: '43' }, balanceMinor: 1_000 },
      }), { status: 422, code: 'invalid_bank_state' });
      expect(repository.getBankState('42')).toBeNull();
    } finally {
      repository.close();
    }
  });

  it('rejects overdraft atomically with typed amounts, then applies and replays a safe expense', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'expense', amountMinor: 1_001 },
      }), {
        status: 422,
        code: 'insufficient_funds',
        details: { availableMinor: 1_000, requiredMinor: 1_001 },
      });
      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'expense', amountMinor: 1_001 },
      }), {
        status: 422,
        code: 'insufficient_funds',
        details: { availableMinor: 1_000, requiredMinor: 1_001 },
      });
      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'expense', amountMinor: 1_002 },
      }), { status: 409, code: 'idempotency_conflict' });
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 1_000 },
      });

      const input = {
        telegramUserId: '42',
        sourceKind: 'tma' as const,
        operationId: 'cccccccccccccccccccccccccccccccc',
        rawCommand: { kind: 'expense', amountMinor: 250 },
      };
      const applied = service.executeCommand(input);
      const replay = service.executeCommand(input);
      expect(applied).toMatchObject({
        applied: true,
        replayed: false,
        operationRevision: 2,
        revision: 2,
        outcome: { ok: true, applied: true },
        state: { balanceMinor: 750 },
      });
      expect(replay).toMatchObject({ applied: true, replayed: true, revision: 2 });
      expectServiceError(() => service.executeCommand({
        ...input,
        rawCommand: { kind: 'expense', amountMinor: 251 },
      }), { status: 409, code: 'idempotency_conflict' });
    } finally {
      repository.close();
    }
  });

  it('does not hide due materialization inside a rejected TMA command', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: {
          profile: { telegramId: '42' },
          balanceMinor: 1_000,
          due: true,
        },
      });

      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'expense', amountMinor: 1_026 },
      }), {
        status: 422,
        code: 'insufficient_funds',
        details: { availableMinor: 1_025, requiredMinor: 1_026 },
      });
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 1_000, due: true },
      });

      expect(service.bootstrap('42')).toMatchObject({
        revision: 2,
        state: { balanceMinor: 1_025, due: false },
        warnings: [{ code: 'income_materialized' }],
      });
    } finally {
      repository.close();
    }
  });

  it('rolls back the operation when the complete post-command state fails validation', () => {
    const repository = new PreferencesRepository(':memory:');
    let emitInvalidState = true;
    const regressingDomain: BankDomainAdapter<TestState, TestCommand> = {
      ...domain,
      applyCommand: (state, command, nowISO) => {
        const result = domain.applyCommand(state, command, nowISO);
        if ('code' in result || !emitInvalidState) return result;
        return {
          ...result,
          state: { ...result.state, balanceMinor: -1 },
        };
      },
    };
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      regressingDomain,
      () => new Date(1_700_000_000_000),
    );
    const command = {
      telegramUserId: '42',
      sourceKind: 'telegram' as const,
      operationId: '700',
      rawCommand: { kind: 'income', amountMinor: 100 },
      chatId: '42',
    };
    try {
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });

      expect(() => service.executeCommand(command)).toThrow();
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 1_000 },
      });
      expect(repository.listBankOutbox()).toEqual([]);

      emitInvalidState = false;
      expect(service.executeCommand(command)).toMatchObject({
        revision: 2,
        operationRevision: 2,
        state: { balanceMinor: 1_100 },
      });
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('deduplicates pre-command and resumed recurring warnings before bounded persistence', () => {
    const repository = new PreferencesRepository(':memory:');
    const recurringWarnings = Array.from({ length: 64 }, (_, index) => ({
      ruleId: `rr_${index}`,
      reason: 'insufficient_funds',
    }));
    const warningDomain: BankDomainAdapter<TestState, TestCommand> = {
      ...domain,
      materialize: (state) => ({ state, warnings: recurringWarnings }),
      applyCommand: (state, command, nowISO) => {
        const result = domain.applyCommand(state, command, nowISO);
        if ('code' in result) return result;
        return {
          ...result,
          warnings: [{ ruleId: 'rr_0', reason: 'insufficient_funds' }],
        };
      },
    };
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      warningDomain,
      () => new Date(1_700_000_000_000),
    );
    try {
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      const response = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 100 },
      });

      expect(response.warnings).toEqual(recurringWarnings);
      expect(response.state).toMatchObject({ balanceMinor: 1_100 });
      expect(repository.listBankOutbox()).toEqual([
        expect.objectContaining({
          telegramUserId: '42',
          chatId: '42',
          messageKind: 'bank_materialization_warning',
          payload: { warnings: recurringWarnings },
        }),
      ]);
      expect(service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 100 },
      })).toMatchObject({ replayed: true });
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('materializes due rows under the repository lock and publishes the new digest', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000, due: true },
      });
      const first = service.materialize('42');
      const second = service.materialize('42');
      expect(first).toMatchObject({
        revision: 2,
        state: { balanceMinor: 1_025, due: false },
        warnings: [{ code: 'income_materialized' }],
      });
      expect(second).toMatchObject({ revision: 2, warnings: [] });
      expect(second.digest).toBe(first.digest);
      expect(repository.listBankOutbox()).toEqual([
        expect.objectContaining({
          messageKind: 'bank_materialization_warning',
          payload: { warnings: [{ code: 'income_materialized' }] },
        }),
      ]);
    } finally {
      repository.close();
    }
  });

  it('queues a Telegram result with the financial operation but never for TMA', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '700',
        rawCommand: { kind: 'income', amountMinor: 100 },
        chatId: '42',
      });
      expect(repository.listBankOutbox()).toEqual([expect.objectContaining({
        telegramUserId: '42',
        payload: {
          applied: true,
          operationKind: 'record_transaction',
          incomingAmountMinor: 100,
          warnings: [],
        },
      })]);
    } finally {
      repository.close();
    }
  });

  it('rejects commands while authority is disabled', () => {
    const { repository, service } = createService();
    try {
      expect(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        rawCommand: { kind: 'income', amountMinor: 1 },
      })).toThrow(BankServiceError);
      try {
        service.materialize('42');
      } catch (error) {
        expect(error).toMatchObject({ status: 503, code: 'bank_authority_disabled' });
      }
    } finally {
      repository.close();
    }
  });

  it('maps repository operation capacity to a typed public error on every authority path', async () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      vi.spyOn(repository, 'importBankState').mockImplementation(() => {
        throw new BankOperationCapacityError();
      });
      expectServiceError(() => service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }), { status: 409, code: 'operation_capacity' });

      vi.restoreAllMocks();
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      vi.spyOn(repository, 'executeBankOperation').mockImplementation(() => {
        throw new BankOperationCapacityError();
      });
      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 1 },
      }), { status: 409, code: 'operation_capacity' });

      vi.restoreAllMocks();
      const ratesService = new BankAuthorityService(
        repository,
        { ...domain, replaceExchangeRates: (state) => state },
        () => new Date(1_700_000_000_000),
        { get: async () => ({
          base: 'USD',
          asOf: '2023-11-14',
          fetchedAt: '2023-11-14T22:13:20.000Z',
          source: 'frankfurter',
          rates: {
            USD: '1', EUR: '0.9', RUB: '90', KZT: '460',
            THB: '35', VND: '24000', IDR: '15000', GEL: '2.7',
          },
        }) },
      );
      vi.spyOn(repository, 'mutateBankState').mockImplementation(() => {
        throw new BankOperationCapacityError();
      });
      await expect(ratesService.refreshRates('42')).rejects.toMatchObject({
        status: 409,
        code: 'operation_capacity',
      });
    } finally {
      vi.restoreAllMocks();
      repository.close();
    }
  });

  it('keeps the last canonical snapshot readable when bootstrap materialization exceeds capacity', () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: {
          profile: { telegramId: '42' },
          balanceMinor: 1_000,
          due: true,
          padding: 'x'.repeat(MAX_BANK_STATE_JSON_BYTES - 256),
        },
      });

      const before = repository.getBankState('42');
      expect(service.bootstrap('42')).toMatchObject({
        mode: 'server',
        serverTime: '2023-11-14T22:13:20.000Z',
        revision: before?.revision,
        digest: before?.digest,
        state: { balanceMinor: 1_000, due: true },
        warnings: [],
      });
      expect(repository.getBankState('42')).toEqual(before);

      vi.restoreAllMocks();
      const failure = new Error('materialization failed');
      vi.spyOn(repository, 'mutateBankState').mockImplementation(() => {
        throw failure;
      });
      expect(() => service.bootstrap('42')).toThrow(failure);
    } finally {
      vi.restoreAllMocks();
      repository.close();
    }
  });

  it('bypasses overflowing due materialization only for reset_demo', () => {
    const repository = new PreferencesRepository(':memory:');
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    const capacityDomain: BankDomainAdapter<TestState, TestCommand> = {
      ...domain,
      serializeState: (state) => {
        if (state.balanceMinor > 1_000) throw new BankStateCapacityError();
        return canonicalJson(state);
      },
    };
    const service = new BankAuthorityService(
      repository,
      capacityDomain,
      () => new Date(1_700_000_000_000),
    );
    try {
      repository.setLedgerMode('server');
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000, due: true },
      });

      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 1 },
      }), { status: 413, code: 'bank_state_too_large' });
      expect(repository.getBankState('42')?.state).toMatchObject({ balanceMinor: 1_000, due: true });

      const reset = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'cccccccccccccccccccccccccccccccc',
        rawCommand: { kind: 'reset_demo' },
      });
      expect(reset).toMatchObject({
        applied: true,
        state: { balanceMinor: 100, due: false },
      });
      expect(repository.getBankState('42')?.state).toMatchObject({ balanceMinor: 100, due: false });
    } finally {
      repository.close();
    }
  });

  it('uses one captured serverTime for every server-state response', async () => {
    const repository = new PreferencesRepository(':memory:');
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    const times = [
      '2023-11-14T22:13:20.001Z',
      '2023-11-14T22:13:20.002Z',
      '2023-11-14T22:13:20.003Z',
      '2023-11-14T22:13:20.004Z',
    ];
    const clock = vi.fn(() => new Date(times.shift() ?? 'invalid'));
    const service = new BankAuthorityService(
      repository,
      { ...domain, replaceExchangeRates: (state) => state },
      clock,
      { get: async () => ({
        base: 'USD',
        asOf: '2023-11-14',
        fetchedAt: '2023-11-14T22:13:20.000Z',
        source: 'frankfurter',
        rates: {
          USD: '1', EUR: '0.9', RUB: '90', KZT: '460',
          THB: '35', VND: '24000', IDR: '15000', GEL: '2.7',
        },
      }) },
    );
    try {
      repository.setLedgerMode('server');
      const imported = service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      const command = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 1 },
      });
      const bootstrap = service.bootstrap('42');
      const rates = await service.refreshRates('42');

      expect(imported.serverTime).toBe('2023-11-14T22:13:20.001Z');
      expect(command.serverTime).toBe('2023-11-14T22:13:20.002Z');
      expect(bootstrap).toMatchObject({ serverTime: '2023-11-14T22:13:20.003Z' });
      expect(rates.serverTime).toBe('2023-11-14T22:13:20.004Z');
      expect(clock).toHaveBeenCalledTimes(4);
    } finally {
      repository.close();
    }
  });

  it('maps oversized repository states to bank_state_too_large on import and write paths', async () => {
    const { repository, service } = createService();
    try {
      repository.setLedgerMode('server');
      vi.spyOn(repository, 'importBankState').mockImplementation(() => {
        throw new BankStateCapacityError();
      });
      expectServiceError(() => service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      }), { status: 413, code: 'bank_state_too_large' });

      vi.restoreAllMocks();
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: { profile: { telegramId: '42' }, balanceMinor: 1_000 },
      });
      vi.spyOn(repository, 'executeBankOperation').mockImplementation(() => {
        throw new BankStateCapacityError();
      });
      expectServiceError(() => service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        rawCommand: { kind: 'income', amountMinor: 1 },
      }), { status: 413, code: 'bank_state_too_large' });

      const ratesService = new BankAuthorityService(
        repository,
        { ...domain, replaceExchangeRates: (state) => state },
        () => new Date(1_700_000_000_000),
        { get: async () => ({
          base: 'USD',
          asOf: '2023-11-14',
          fetchedAt: '2023-11-14T22:13:20.000Z',
          source: 'frankfurter',
          rates: {
            USD: '1', EUR: '0.9', RUB: '90', KZT: '460',
            THB: '35', VND: '24000', IDR: '15000', GEL: '2.7',
          },
        }) },
      );
      vi.spyOn(repository, 'mutateBankState').mockImplementation(() => {
        throw new BankStateCapacityError();
      });
      await expect(ratesService.refreshRates('42')).rejects.toMatchObject({
        status: 413,
        code: 'bank_state_too_large',
      });
    } finally {
      vi.restoreAllMocks();
      repository.close();
    }
  });
});
