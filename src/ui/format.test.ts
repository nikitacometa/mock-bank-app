import { describe, expect, it } from 'vitest';
import { buildSeed } from '@/domain/seed';
import type { Transaction } from '@/domain/types';
import {
  accountDisplayName,
  buildOwnTransferCounterpartIndex,
  categoryLabel,
  fmtDay,
  fmtRateDate,
  fmtTime,
  fmtTransactionDay,
  localizeDemoText,
  shouldShowTransactionTime,
  transactionCounterpartyDisplayName,
  transactionDayKey,
} from './format';

describe('localized UI formatting', () => {
  it('formats relative and calendar days in both interface languages', () => {
    const now = new Date('2026-09-02T12:00:00');
    expect(fmtDay('2026-09-02T08:00:00', 'ru', now)).toBe('Сегодня');
    expect(fmtDay('2026-09-02T08:00:00', 'en', now)).toBe('Today');
    expect(fmtDay('2026-09-01T08:00:00', 'en', now)).toBe('Yesterday');
    expect(fmtDay('2026-08-31T08:00:00', 'en', now)).toBe('August 31');
  });

  it('formats immutable provider dates in UTC without a timezone day shift', () => {
    expect(fmtRateDate('2026-09-01', 'ru')).toContain('1');
    expect(fmtRateDate('2026-09-01', 'en')).toBe('Sep 1');
    expect(fmtRateDate('2026-09-01', 'en', 'full')).toBe('09/01/2026');
  });

  it('groups and formats a backfilled transaction by its explicit UTC banking date', () => {
    const transaction = {
      id: 'tx_backfill',
      accountId: 'acc_checking',
      seq: 1,
      amountMinor: -100,
      balanceAfterMinor: 900,
      kind: 'manual_expense',
      effectiveDate: '2026-08-31',
      createdAt: '2026-09-05T23:59:00.000Z',
    } satisfies Transaction;
    const now = new Date('2026-09-05T00:15:00.000Z');

    expect(transactionDayKey(transaction)).toBe('2026-08-31');
    expect(fmtTransactionDay(transaction, 'en', now)).toBe('August 31');
    expect(fmtTransactionDay(transaction, 'ru', now)).toBe('31 августа');
  });

  it('uses calendar-day arithmetic across daylight-saving transitions', () => {
    const now = new Date(2026, 2, 9, 0, 30);
    const previousCalendarDay = new Date(2026, 2, 8, 23, 30);

    expect(fmtDay(previousCalendarDay.toISOString(), 'en', now)).toBe('Yesterday');
  });

  it('formats transaction time for the selected interface locale', () => {
    const bankingTime = '2026-09-01T18:05:00.000Z';

    expect(fmtTime(bankingTime, 'ru')).toBe('18:05');
    expect(fmtTime(bankingTime, 'en')).toBe('6:05 PM');
  });

  it('keeps the UTC banking clock stable across a runtime device time-zone change', () => {
    const environment = (
      globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
      }
    ).process?.env;
    if (environment === undefined) throw new Error('test runtime has no process environment');
    const originalTimeZone = environment.TZ;
    try {
      environment.TZ = 'UTC';
      expect(new Date('2026-09-01T12:34:00.000Z').getHours()).toBe(12);
      expect(fmtTime('2026-09-01T12:34:00.000Z', 'en')).toBe('12:34 PM');

      environment.TZ = 'America/New_York';
      expect(new Date('2026-09-01T12:34:00.000Z').getHours()).toBe(8);
      expect(fmtTime('2026-09-01T12:34:00.000Z', 'en')).toBe('12:34 PM');
    } finally {
      if (originalTimeZone === undefined) delete environment.TZ;
      else environment.TZ = originalTimeZone;
    }
  });

  it.each(['Asia/Bangkok', 'America/New_York', 'Pacific/Kiritimati'])(
    'groups mixed ledger rows and labels today on the same UTC calendar in %s', (timeZone) => {
      const environment = (
        globalThis as typeof globalThis & {
          process?: { env: Record<string, string | undefined> };
        }
      ).process?.env;
      if (environment === undefined) throw new Error('test runtime has no process environment');
      const originalTimeZone = environment.TZ;
      environment.TZ = timeZone;
      try {
        expect(new Date('2026-09-02T22:30:00.000Z').getHours()).not.toBe(22);
        for (const createdAt of ['2026-09-02T22:30:00.000Z', '2026-09-03T00:30:00.000Z']) {
          const transfer: Transaction = {
            id: 'tx_utc_transfer', accountId: 'acc_checking', seq: 1,
            amountMinor: -100, balanceAfterMinor: 900, kind: 'transfer_own_out', createdAt,
          };
          const expense: Transaction = {
            ...transfer, id: 'tx_utc_expense', seq: 2, kind: 'manual_expense',
            effectiveDate: createdAt.slice(0, 10),
          };
          const now = new Date(createdAt);
          expect(transactionDayKey(transfer)).toBe(createdAt.slice(0, 10));
          expect(transactionDayKey(expense)).toBe(transactionDayKey(transfer));
          expect(fmtTransactionDay(transfer, 'en', now)).toBe('Today');
          expect(fmtTransactionDay(expense, 'en', now)).toBe('Today');
          expect(fmtTransactionDay(transfer, 'ru', now)).toBe('Сегодня');
          const nextDay = new Date(now.getTime() + 86_400_000);
          expect(fmtTransactionDay(transfer, 'en', nextDay)).toBe('Yesterday');
          expect(fmtTransactionDay(expense, 'en', nextDay)).toBe('Yesterday');
          expect(fmtTime(createdAt, 'ru')).toBe(createdAt.slice(11, 16));
        }
      } finally {
        if (originalTimeZone === undefined) delete environment.TZ;
        else environment.TZ = originalTimeZone;
      }
    },
  );

  it('localizes category and known demo data while preserving unknown user text', () => {
    expect(categoryLabel('groceries', 'en')).toBe('Groceries');
    expect(categoryLabel('constructor', 'en')).toBe('Other');
    expect(localizeDemoText('Городское такси', 'en')).toBe('City Taxi');
    expect(localizeDemoText('Сверка итогового баланса', 'en')).toBe(
      'Statement balance reconciliation',
    );
    expect(localizeDemoText('Custom Merchant', 'en')).toBe('Custom Merchant');
    expect(localizeDemoText('constructor', 'en')).toBe('constructor');
    expect(localizeDemoText('Городское такси', 'ru')).toBe('Городское такси');
    expect(localizeDemoText('Current', 'ru')).toBe('Текущий');
    expect(localizeDemoText('External account top up', 'ru')).toBe(
      'Пополнение с внешнего счёта',
    );
    expect(localizeDemoText('Custom Merchant', 'ru')).toBe('Custom Merchant');
  });

  it('uses account roles for fixture labels and localizes only the generated custom template', () => {
    const state = buildSeed('2026-09-02T00:00:00.000Z', 'GEL');
    const checking = state.accounts.find((account) => account.role === 'primary-checking');
    const companion = state.accounts.find((account) => account.role === 'companion-1');
    if (checking === undefined || companion === undefined) throw new Error('fixture is incomplete');

    expect(accountDisplayName(checking, 'ru')).toBe('Текущий');
    expect(accountDisplayName(companion, 'en')).not.toBe(companion.currency);
    expect(accountDisplayName({ ...companion, role: 'custom', currency: 'GEL', name: 'Everyday GEL' }, 'ru'))
      .toBe('Повседневный');
    expect(accountDisplayName({ ...companion, role: 'custom', name: 'My GEL' }, 'ru'))
      .toBe('My GEL');
    expect(accountDisplayName({ ...companion, role: 'custom', name: 'Current' }, 'ru'))
      .toBe('Current');
    expect(accountDisplayName({ ...companion, role: 'custom', name: 'Текущий' }, 'en'))
      .toBe('Текущий');
  });

  it('localizes fixture counterparties but preserves colliding manual text exactly', () => {
    const fixture = {
      id: 'tx_fixture',
      accountId: 'acc_checking',
      seq: 1,
      amountMinor: -100,
      balanceAfterMinor: 900,
      kind: 'purchase',
      counterparty: 'Апа',
      createdAt: '2026-09-05T12:00:00.000Z',
    } satisfies Transaction;

    expect(transactionCounterpartyDisplayName(fixture, 'en')).toBe('Mum');
    expect(
      transactionCounterpartyDisplayName({ ...fixture, kind: 'manual_expense' }, 'en'),
    ).toBe('Апа');
    expect(
      transactionCounterpartyDisplayName(
        { ...fixture, kind: 'manual_income', counterparty: 'Current' },
        'ru',
      ),
    ).toBe('Current');
  });

  it('uses the counterpart account role for own-transfer names', () => {
    const state = buildSeed('2026-09-02T00:00:00.000Z', 'USD');
    const source = state.accounts[0];
    const target = { ...state.accounts[1], role: 'custom' as const, name: 'Current' };
    const outgoing = {
      id: 'tx_custom_account_out',
      accountId: source.id,
      seq: 1,
      amountMinor: -100,
      balanceAfterMinor: 900,
      kind: 'transfer_own_out' as const,
      counterparty: target.name,
      category: 'transfer',
      transferGroupId: 'grp_custom_account',
      createdAt: '2026-09-05T12:00:00.000Z',
    };
    const incoming = {
      ...outgoing,
      id: 'tx_custom_account_in',
      accountId: target.id,
      seq: 2,
      amountMinor: 100,
      balanceAfterMinor: 1_100,
      kind: 'transfer_own_in' as const,
      counterparty: source.name,
    };
    const index = buildOwnTransferCounterpartIndex(
      [source, target],
      [outgoing, incoming],
    );

    expect(index.get(outgoing.id)?.id).toBe(target.id);
    expect(index.get(incoming.id)?.id).toBe(source.id);
    expect(
      transactionCounterpartyDisplayName(outgoing, 'ru', index),
    ).toBe('Current');
    const localizedTarget = { ...target, name: 'Текущий' };
    const localizedIndex = buildOwnTransferCounterpartIndex(
      [source, localizedTarget],
      [outgoing, incoming],
    );
    expect(
      transactionCounterpartyDisplayName(
        { ...outgoing, counterparty: 'Текущий' },
        'en',
        localizedIndex,
      ),
    ).toBe('Текущий');
  });

  it('shows occurrence time unless an entry was appended on another UTC banking date', () => {
    const transaction = {
      id: 'tx_time',
      accountId: 'acc_checking',
      seq: 1,
      amountMinor: -100,
      balanceAfterMinor: 900,
      kind: 'manual_expense',
      effectiveDate: '2026-09-05',
      createdAt: '2026-09-05T23:47:00.000Z',
    } satisfies Transaction;

    expect(shouldShowTransactionTime(transaction)).toBe(true);
    expect(shouldShowTransactionTime({ ...transaction, effectiveDate: '2026-08-19' })).toBe(false);
  });
});
