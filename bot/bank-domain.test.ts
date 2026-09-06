import { describe, expect, it, vi } from 'vitest';
import { applyBankCommand } from '../src/domain/bankCommands.js';
import { accruedInterest } from '../src/domain/interest.js';
import { appendRow, balanceOf, transactionsOf } from '../src/domain/ledger.js';
import { buildSeed, SAVINGS_ID, SAVINGS_APY } from '../src/domain/seed.js';
import type { BankState, ExchangeRateSnapshot } from '../src/domain/types.js';
import {
  bankDomainAdapter,
  materializeBankState,
  snapshotRecurringWarningContexts,
} from './bank-domain.js';
import { BankAuthorityService, BankServiceError } from './bank-service.js';
import { PreferencesRepository } from './repository.js';

const NOW_ISO = '2026-09-05T12:00:00.000Z';

function amountInput(minor: number): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function seededFor(telegramId: string): BankState {
  const seed = buildSeed(NOW_ISO, 'KZT');
  return {
    ...seed,
    profile: { displayName: 'Ada', telegramId },
  };
}

function padTransactions(
  state: BankState,
  target: number,
  createdAt: string,
): BankState {
  if (target < state.transactions.length) throw new Error('Target is below seed size');
  const accountId = state.accounts.find((account) => account.role === 'primary-checking')?.id;
  if (accountId === undefined) throw new Error('Missing primary checking account');
  const balance = balanceOf(state, accountId);
  const added = Array.from(
    { length: target - state.transactions.length },
    (_, index) => {
      const seq = state.nextSeq + index;
      return {
        id: `tx_${seq}`,
        accountId,
        seq,
        amountMinor: 0,
        balanceAfterMinor: balance,
        kind: 'purchase' as const,
        counterparty: 'Capacity fixture',
        createdAt,
      };
    },
  );
  return {
    ...state,
    transactions: [...state.transactions, ...added],
    nextSeq: state.nextSeq + added.length,
  };
}

function liveRates(
  asOf = '2026-09-05',
  fetchedAt = NOW_ISO,
): ExchangeRateSnapshot {
  return {
    base: 'USD',
    asOf,
    fetchedAt,
    source: 'frankfurter',
    rates: {
      USD: '1',
      EUR: '0.86',
      RUB: '86.2',
      KZT: '462.2',
      THB: '33.1',
      VND: '26044',
      IDR: '17710',
      GEL: '2.61',
    },
  };
}

describe('shared bot bank domain adapter', () => {
  it('keeps deferred interest capacity unavailable to recurring rows', () => {
    const createdAt = '2026-09-02T12:00:00.000Z';
    let state = buildSeed(createdAt, 'KZT');
    state = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.id === 'acc_usd'
          ? {
              ...account,
              type: 'savings' as const,
              apy: 0.04,
              accrualAnchor: createdAt,
            }
          : account,
      ),
    };
    const created = applyBankCommand(state, {
      kind: 'create_recurring',
      ruleId: 'rr_capacity_reservation',
      accountId: 'acc_checking',
      direction: 'income',
      amountInput: '1.00',
      locale: 'en',
      counterparty: 'Studio retainer',
      startYear: 2026,
      startMonth: 9,
      anchorDay: 5,
    }, { nowISO: createdAt });
    if (!created.ok) throw new Error(`Recurring setup failed: ${created.error}`);
    state = padTransactions(created.state, 4_999, createdAt);
    const anchorsBefore = state.accounts
      .filter((account) => account.type === 'savings')
      .map((account) => [account.id, account.accrualAnchor]);

    const result = materializeBankState(state, '2026-09-05T12:00:00.000Z');

    expect(result.state.transactions).toHaveLength(4_999);
    expect(result.state.accounts
      .filter((account) => account.type === 'savings')
      .map((account) => [account.id, account.accrualAnchor])).toEqual(anchorsBefore);
    expect(result.state.recurringRules).toEqual([
      expect.objectContaining({
        id: 'rr_capacity_reservation',
        status: 'paused',
        pauseReason: 'capacity',
      }),
    ]);
    expect(result.warnings).toEqual([
      { ruleId: 'rr_capacity_reservation', reason: 'capacity' },
    ]);
  });

  it('keeps an exact-cap ledger readable and allows reset after deferred settlement', () => {
    let nowISO = NOW_ISO;
    const repository = new PreferencesRepository(':memory:', () => new Date(nowISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(nowISO),
    );
    try {
      const imported = padTransactions(seededFor('42'), 5_000, NOW_ISO);
      const anchorBefore = imported.accounts.find((account) => account.id === SAVINGS_ID)
        ?.accrualAnchor;
      service.importState({
        telegramUserId: '42',
        importId: 'abababababababababababababababab',
        stateVersion: 5,
        rawState: imported,
      });

      nowISO = '2026-09-30T12:00:00.000Z';
      const bootstrap = service.bootstrap('42');
      if (bootstrap?.mode !== 'server') throw new Error('Missing server bank state');
      expect(bootstrap.state.transactions).toHaveLength(5_000);
      expect(bootstrap.state.accounts.find((account) => account.id === SAVINGS_ID)
        ?.accrualAnchor).toBe(anchorBefore);

      const reset = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
        rawCommand: { kind: 'reset_demo' },
      });
      expect(reset.outcome).toEqual({ ok: true, applied: true });
      expect(reset.state.transactions.length).toBeLessThan(5_000);
    } finally {
      repository.close();
    }
  });

  it('settles savings before recurring rows while preserving recurring warnings', () => {
    let state = seededFor('42');
    const usdBalance = balanceOf(state, 'acc_usd');
    state = appendRow(state, {
      accountId: 'acc_usd',
      amountMinor: -usdBalance,
      kind: 'manual_expense',
      counterparty: 'Move to cold storage',
      category: 'transfer',
      effectiveDate: '2026-09-05',
      createdAt: NOW_ISO,
    });

    for (const command of [
      {
        kind: 'create_recurring' as const,
        ruleId: 'rr_monthly_income',
        accountId: 'acc_checking',
        direction: 'income' as const,
        amountInput: '1000.00',
        locale: 'en' as const,
        counterparty: 'Studio retainer',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
      {
        kind: 'create_recurring' as const,
        ruleId: 'rr_cloud_warning',
        accountId: 'acc_usd',
        direction: 'expense' as const,
        amountInput: '12.34',
        locale: 'en' as const,
        counterparty: 'Original Cloud',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
    ]) {
      const created = applyBankCommand(state, command, { nowISO: NOW_ISO });
      if (!created.ok) throw new Error(`Recurring setup failed: ${created.error}`);
      state = created.state;
    }

    const materializedAt = '2026-09-30T12:00:00.000Z';
    const result = materializeBankState(state, materializedAt);
    const interest = result.state.transactions.find((transaction) =>
      transaction.accountId === SAVINGS_ID &&
      transaction.kind === 'interest' &&
      transaction.createdAt === materializedAt);
    const income = result.state.transactions.find((transaction) =>
      transaction.recurringRuleId === 'rr_monthly_income');

    expect(interest).toBeDefined();
    expect(income).toBeDefined();
    expect(interest!.seq).toBeLessThan(income!.seq);
    expect(result.warnings).toEqual([{
      ruleId: 'rr_cloud_warning',
      reason: 'insufficient_funds',
      availableMinor: 0,
      requiredMinor: 1_234,
    }]);
  });

  it('settles savings during bootstrap reads and remains idempotent on the same UTC day', () => {
    let nowISO = NOW_ISO;
    const repository = new PreferencesRepository(':memory:', () => new Date(nowISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(nowISO),
    );
    try {
      const initial = seededFor('42');
      const savings = initial.accounts.find((account) => account.id === SAVINGS_ID);
      if (savings?.accrualAnchor === undefined) throw new Error('Missing savings anchor');
      const beforeBalance = balanceOf(initial, SAVINGS_ID);
      const beforeRows = transactionsOf(initial, SAVINGS_ID)
        .filter((transaction) => transaction.kind === 'interest').length;
      service.importState({
        telegramUserId: '42',
        importId: '12121212121212121212121212121212',
        stateVersion: 5,
        rawState: initial,
      });

      nowISO = '2026-09-30T08:00:00.000Z';
      const first = service.bootstrap('42');
      if (first?.mode !== 'server') throw new Error('Missing server bank state');
      const firstState = first.state as BankState;
      expect(first.revision).toBe(2);
      expect(balanceOf(firstState, SAVINGS_ID)).toBe(
        beforeBalance + accruedInterest(
          beforeBalance,
          SAVINGS_APY,
          savings.accrualAnchor,
          nowISO,
        ),
      );
      expect(transactionsOf(firstState, SAVINGS_ID)
        .filter((transaction) => transaction.kind === 'interest')).toHaveLength(beforeRows + 1);

      nowISO = '2026-09-30T23:59:59.999Z';
      const second = service.materialize('42');
      expect(second.revision).toBe(first.revision);
      expect(second.digest).toBe(first.digest);
      expect(second.state).toEqual(first.state);
      expect(second.warnings).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('freezes bounded recurring warning facts from the matching canonical revision', () => {
    const state = seededFor('42');
    const created = applyBankCommand(state, {
      kind: 'create_recurring',
      ruleId: 'rr_frozen_warning',
      accountId: 'acc_usd',
      direction: 'expense',
      amountInput: '12.34',
      locale: 'en',
      counterparty: 'Original Cloud',
      startYear: 2026,
      startMonth: 9,
      anchorDay: 30,
    }, { nowISO: NOW_ISO });
    if (!created.ok) throw new Error(`Recurring setup failed: ${created.error}`);

    const contexts = snapshotRecurringWarningContexts(created.state, [{
      ruleId: 'rr_frozen_warning',
      reason: 'insufficient_funds',
      availableMinor: 0,
      requiredMinor: 1_234,
    }]);

    expect(contexts).toEqual([{
      ruleId: 'rr_frozen_warning',
      reason: 'insufficient_funds',
      counterparty: 'Original Cloud',
      currency: 'USD',
      availableMinor: 0,
      requiredMinor: 1_234,
    }]);
    expect(Object.isFrozen(contexts)).toBe(true);
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(() => snapshotRecurringWarningContexts(created.state, [{
      ruleId: 'rr_frozen_warning',
      reason: 'insufficient_funds',
    }])).toThrow('invalid money context');
    expect(() => snapshotRecurringWarningContexts(
      created.state,
      Array.from({ length: 65 }, () => ({
        ruleId: 'rr_frozen_warning',
        reason: 'capacity',
      })),
    )).toThrow('Too many recurring warnings');
  });

  it('runs strict domain commands atomically with no overdraft and historical backfill', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(NOW_ISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(NOW_ISO),
    );
    try {
      const imported = service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: seededFor('42'),
      });
      const checking = imported.state.accounts.find((account) =>
        account.role === 'primary-checking');
      expect(checking).toBeDefined();
      const balance = balanceOf(imported.state, checking!.id);

      try {
        service.executeCommand({
          telegramUserId: '42',
          sourceKind: 'tma',
          operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          rawCommand: {
            kind: 'record_transaction',
            accountId: checking!.id,
            direction: 'expense',
            amountInput: amountInput(balance + 1),
            locale: 'en',
            counterparty: 'Magnum',
            effectiveDate: '2026-09-05',
          },
        });
        throw new Error('Expected overdraft rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(BankServiceError);
        expect(error).toMatchObject({
          status: 422,
          code: 'insufficient_funds',
          details: { availableMinor: balance, requiredMinor: balance + 1 },
        });
      }
      expect(repository.getBankState('42')).toMatchObject({ revision: 1 });

      const expense = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'cccccccccccccccccccccccccccccccc',
        rawCommand: {
          kind: 'record_transaction',
          accountId: checking!.id,
          direction: 'expense',
          amountInput: '1.00',
          locale: 'en',
          counterparty: 'Magnum',
          note: 'Lunch',
          effectiveDate: '2026-09-05',
        },
      });
      expect(balanceOf(expense.state, checking!.id)).toBe(balance - 100);

      const recurring = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'dddddddddddddddddddddddddddddddd',
        rawCommand: {
          kind: 'create_recurring',
          ruleId: 'rr_spotify_demo',
          accountId: checking!.id,
          direction: 'expense',
          amountInput: '1.00',
          locale: 'en',
          counterparty: 'Spotify',
          category: 'subscriptions',
          startYear: 2026,
          startMonth: 7,
          anchorDay: 5,
        },
      });
      expect(recurring.outcome).toEqual({ ok: true, applied: true, backfilled: 3 });
      expect(recurring.state.recurringRules).toEqual([
        expect.objectContaining({ id: 'rr_spotify_demo', nextOccurrence: '2026-10-05' }),
      ]);
      expect(balanceOf(recurring.state, checking!.id)).toBe(balance - 400);
    } finally {
      repository.close();
    }
  });

  it('preserves the real domain outcome in the TMA command response', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(NOW_ISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(NOW_ISO),
    );
    try {
      service.importState({
        telegramUserId: '42',
        importId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        stateVersion: 5,
        rawState: seededFor('42'),
      });
      const response = service.executeCommand({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'ffffffffffffffffffffffffffffffff',
        rawCommand: {
          kind: 'transfer',
          request: {
            fromAccountId: 'acc_checking',
            toAccountId: 'acc_usd',
            amountMinor: 46_227,
            clientTransferId: 'ct_real_adapter_wire_outcome',
          },
        },
      });

      expect(response).toMatchObject({
        version: 1,
        mode: 'server',
        telegramId: '42',
        applied: true,
        replayed: false,
        outcome: { ok: true, applied: true, incomingAmountMinor: 100 },
      });
    } finally {
      repository.close();
    }
  });

  it('replaces fallback rates through the server provider and keeps the revision stable on cache replay', async () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(NOW_ISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const snapshot = liveRates();
    const provider = { get: vi.fn(async () => snapshot) };
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(NOW_ISO),
      provider,
    );
    try {
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: seededFor('42'),
      });

      await expect(service.refreshRates('42')).resolves.toMatchObject({
        version: 1,
        updated: true,
        revision: 2,
        state: { exchangeRates: snapshot },
      });
      await expect(service.refreshRates('42')).resolves.toMatchObject({
        updated: false,
        revision: 2,
        state: { exchangeRates: snapshot },
      });
      expect(provider.get).toHaveBeenCalledTimes(2);
    } finally {
      repository.close();
    }
  });

  it('ignores an older delayed provider snapshot and preserves state on typed provider failure', async () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(NOW_ISO));
    repository.ensureUser({
      telegramUserId: '42',
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada',
    });
    repository.setLedgerMode('server');
    const older = liveRates('2026-09-03', '2026-09-05T11:00:00.000Z');
    const provider = {
      get: vi.fn()
        .mockResolvedValueOnce(older)
        .mockRejectedValueOnce(new TypeError('provider detail must stay private')),
    };
    const service = new BankAuthorityService(
      repository,
      bankDomainAdapter,
      () => new Date(NOW_ISO),
      provider,
    );
    try {
      const importedState = {
        ...seededFor('42'),
        exchangeRates: liveRates('2026-09-04', '2026-09-05T10:00:00.000Z'),
      };
      service.importState({
        telegramUserId: '42',
        importId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stateVersion: 5,
        rawState: importedState,
      });

      await expect(service.refreshRates('42')).resolves.toMatchObject({
        updated: false,
        revision: 1,
        state: { exchangeRates: importedState.exchangeRates },
      });
      await expect(service.refreshRates('42')).rejects.toMatchObject({
        status: 503,
        code: 'bank_rates_unavailable',
      });
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { exchangeRates: importedState.exchangeRates },
      });
    } finally {
      repository.close();
    }
  });
});
