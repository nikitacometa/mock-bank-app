import { describe, expect, it } from 'vitest';
import { buildSeed, CHECKING_ID, SAVINGS_ID } from './seed';
import { balanceOf } from './ledger';
import { applyBalanceAdjustment, applyManualTransaction } from './manualTransactions';
import { MAX_COMMAND_USD_MINOR } from './commandLimits';

const NOW = '2026-09-05T12:00:00.000Z';

describe('manual ledger transitions', () => {
  it('records an income and expense with effective dates without mutating earlier rows', () => {
    const initial = buildSeed(NOW);
    const before = balanceOf(initial, CHECKING_ID);
    const income = applyManualTransaction(initial, {
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '1 250,50',
      locale: 'ru',
      counterparty: '  Client   invoice  ',
      note: 'September work',
      category: 'income',
      effectiveDate: '2026-09-01',
      nowISO: NOW,
    });
    expect(income.ok).toBe(true);
    if (!income.ok) return;
    expect(balanceOf(income.state, CHECKING_ID)).toBe(before + 125_050);
    expect(income.state.transactions.at(-1)).toMatchObject({
      kind: 'manual_income',
      amountMinor: 125_050,
      counterparty: 'Client invoice',
      note: 'September work',
      effectiveDate: '2026-09-01',
      createdAt: NOW,
    });

    const expense = applyManualTransaction(income.state, {
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: '250,50',
      locale: 'ru',
      counterparty: 'Spotify',
      category: 'subscriptions',
      effectiveDate: '2026-08-19',
      nowISO: NOW,
    });
    expect(expense.ok).toBe(true);
    if (!expense.ok) return;
    expect(balanceOf(expense.state, CHECKING_ID)).toBe(before + 100_000);
    expect(expense.state.transactions.at(-1)?.amountMinor).toBe(-25_050);
  });

  it('rejects an overdraft atomically with available and required amounts', () => {
    const state = buildSeed(NOW);
    const before = state.transactions;
    const available = balanceOf(state, CHECKING_ID);
    const outcome = applyManualTransaction(state, {
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: String(Math.floor(available / 100) + 1),
      locale: 'en',
      counterparty: 'Whole Foods',
      effectiveDate: '2026-09-05',
      nowISO: NOW,
    });
    expect(outcome).toEqual({
      ok: false,
      error: 'insufficient_funds',
      availableMinor: available,
      requiredMinor: (Math.floor(available / 100) + 1) * 100,
    });
    expect(state.transactions).toBe(before);
  });

  it('keeps manual income and expense off savings accounts', () => {
    const state = buildSeed(NOW);
    expect(
      applyManualTransaction(state, {
        accountId: SAVINGS_ID,
        direction: 'income',
        amountInput: '100',
        locale: 'en',
        counterparty: 'Income',
        effectiveDate: '2026-09-05',
        nowISO: NOW,
      }),
    ).toEqual({ ok: false, error: 'checking_only' });
  });

  it('rejects a transaction above the USD command ceiling without ledger mutation', () => {
    const state = buildSeed(NOW, 'KZT');
    const before = state.transactions;
    const exact = applyManualTransaction(state, {
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '46227000,00',
      locale: 'ru',
      counterparty: 'Contract',
      effectiveDate: '2026-09-05',
      nowISO: NOW,
    });
    expect(exact.ok).toBe(true);

    const over = applyManualTransaction(state, {
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '46227000,01',
      locale: 'ru',
      counterparty: 'Contract',
      effectiveDate: '2026-09-05',
      nowISO: NOW,
    });
    expect(over).toEqual({ ok: false, error: 'amount_too_large' });
    expect(state.transactions).toBe(before);
  });

  it('settles savings before appending an exact current balance correction', () => {
    const state = buildSeed('2026-09-02T23:59:59.999Z');
    const outcome = applyBalanceAdjustment(state, {
      accountId: SAVINGS_ID,
      targetAmountInput: '10000000',
      locale: 'en',
      nowISO: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(balanceOf(outcome.state, SAVINGS_ID)).toBe(1_000_000_000);
    expect(outcome.state.transactions.slice(-2).map((row) => row.kind)).toEqual([
      'interest',
      'balance_adjustment',
    ]);
    expect(outcome.state.transactions.at(-1)?.effectiveDate).toBe('2026-09-05');
  });

  it('applies the USD command ceiling to the balance adjustment delta', () => {
    const state = buildSeed(NOW, 'USD');
    const current = balanceOf(state, CHECKING_ID);
    const target = current + MAX_COMMAND_USD_MINOR + 1;
    const targetInput = `${Math.floor(target / 100)}.${String(target % 100).padStart(2, '0')}`;

    const outcome = applyBalanceAdjustment(state, {
      accountId: CHECKING_ID,
      targetAmountInput: targetInput,
      locale: 'en',
      nowISO: NOW,
    });

    expect(outcome).toEqual({ ok: false, error: 'amount_too_large' });
  });
});
