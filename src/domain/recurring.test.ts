import { describe, expect, it } from 'vitest';
import { applyBalanceAdjustment } from './manualTransactions';
import { createRecurringRule, materializeRecurringRules } from './recurring';
import { buildSeed, CHECKING_ID } from './seed';
import { balanceOf } from './ledger';

const NOW = '2026-04-15T12:00:00.000Z';

function stateAt(balanceMajor = 10_000) {
  const seed = buildSeed(NOW);
  const adjusted = applyBalanceAdjustment(seed, {
    accountId: CHECKING_ID,
    targetAmountInput: String(balanceMajor),
    locale: 'en',
    nowISO: NOW,
  });
  if (!adjusted.ok) throw new Error(adjusted.error);
  return adjusted.state;
}

describe('monthly recurrence', () => {
  it('backfills a chosen year/month/day, clamps February, and returns to day 31', () => {
    const state = stateAt();
    const outcome = createRecurringRule(state, {
      ruleId: 'rr_month_end',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: '10',
      locale: 'en',
      counterparty: 'Spotify',
      category: 'subscriptions',
      startYear: 2026,
      startMonth: 1,
      anchorDay: 31,
      nowISO: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backfilled).toBe(3);
    expect(outcome.nextOccurrence).toBe('2026-04-30');
    expect(outcome.state.transactions.slice(-3).map((row) => row.effectiveDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(new Set(outcome.state.transactions.slice(-3).map((row) => row.occurrenceKey)).size).toBe(3);
  });

  it('rejects a historical expense batch atomically when any prefix would overdraw', () => {
    const state = stateAt(20);
    const before = state.transactions;
    const outcome = createRecurringRule(state, {
      ruleId: 'rr_too_much',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: '10',
      locale: 'en',
      counterparty: 'Subscription',
      startYear: 2026,
      startMonth: 1,
      anchorDay: 1,
      nowISO: NOW,
    });
    expect(outcome).toEqual({
      ok: false,
      error: 'insufficient_funds',
      availableMinor: 2_000,
      requiredMinor: 4_000,
    });
    expect(state.transactions).toBe(before);
    expect(state.recurringRules).toEqual([]);
  });

  it('rejects future starts and more than 120 backfilled occurrences', () => {
    const state = stateAt();
    const base = {
      ruleId: 'rr_date_limit',
      accountId: CHECKING_ID,
      direction: 'income' as const,
      amountInput: '10',
      locale: 'en' as const,
      counterparty: 'Income',
      anchorDay: 1,
      nowISO: '2026-09-05T12:00:00.000Z',
    };
    expect(createRecurringRule(state, { ...base, startYear: 2026, startMonth: 10 })).toEqual({
      ok: false,
      error: 'invalid_date',
    });
    expect(createRecurringRule(state, { ...base, startYear: 2016, startMonth: 9, anchorDay: 5 })).toEqual({
      ok: false,
      error: 'too_many_occurrences',
    });
  });

  it('creates a zero-occurrence rule for a later billing day in the current UTC month', () => {
    const state = stateAt();
    const outcome = createRecurringRule(state, {
      ruleId: 'rr_later_this_month',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: '10',
      locale: 'en',
      counterparty: 'Month-end subscription',
      startYear: 2026,
      startMonth: 9,
      anchorDay: 30,
      nowISO: '2026-09-05T12:00:00.000Z',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backfilled).toBe(0);
    expect(outcome.nextOccurrence).toBe('2026-09-30');
    expect(outcome.state.transactions).toBe(state.transactions);
    expect(outcome.state.recurringRules).toHaveLength(1);
  });

  it('rejects an over-limit future-current-month rule even with zero backfill', () => {
    const state = buildSeed('2026-09-05T12:00:00.000Z', 'USD');

    expect(createRecurringRule(state, {
      ruleId: 'rr_future_ceiling',
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '100000.01',
      locale: 'en',
      counterparty: 'Consulting',
      startYear: 2026,
      startMonth: 9,
      anchorDay: 30,
      nowISO: '2026-09-05T12:00:00.000Z',
    })).toEqual({ ok: false, error: 'amount_too_large' });
    expect(state.recurringRules).toEqual([]);
  });

  it('applies the USD command ceiling to the complete recurring backfill', () => {
    const state = buildSeed(NOW, 'USD');
    const base = {
      ruleId: 'rr_ceiling',
      accountId: CHECKING_ID,
      direction: 'income' as const,
      locale: 'en' as const,
      counterparty: 'Consulting',
      startYear: 2026,
      startMonth: 1,
      anchorDay: 1,
      nowISO: NOW,
    };
    const exact = createRecurringRule(state, { ...base, amountInput: '25000' });
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.backfilled).toBe(4);

    const over = createRecurringRule(state, { ...base, amountInput: '25000.01' });
    expect(over).toEqual({ ok: false, error: 'amount_too_large' });
    expect(state.recurringRules).toEqual([]);
  });

  it('pauses a due expense without writing a partial row when funds are insufficient', () => {
    const state = stateAt(10);
    const created = createRecurringRule(state, {
      ruleId: 'rr_due',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountInput: '8',
      locale: 'en',
      counterparty: 'Subscription',
      startYear: 2026,
      startMonth: 4,
      anchorDay: 15,
      nowISO: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const beforeCount = created.state.transactions.length;
    const materialized = materializeRecurringRules(created.state, '2026-05-15T12:00:00.000Z');
    expect(materialized.state.transactions).toHaveLength(beforeCount);
    expect(materialized.state.recurringRules[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'insufficient_funds',
      nextOccurrence: '2026-05-15',
    });
    expect(materialized.warnings).toEqual([
      { ruleId: 'rr_due', reason: 'insufficient_funds', availableMinor: 200, requiredMinor: 800 },
    ]);
    expect(balanceOf(materialized.state, CHECKING_ID)).toBe(200);
  });
});
