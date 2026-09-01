import { describe, expect, it } from 'vitest';
import { accruedInterest, applySettleAccount, epochDayUTC } from './interest';
import { buildSeed, SAVINGS_ID, SAVINGS_APY } from './seed';
import { balanceOf, transactionsOf } from './ledger';
import { rub } from './money';

const NOW = '2026-09-01T12:00:00.000Z';

describe('epochDayUTC', () => {
  it('same UTC day regardless of time', () => {
    expect(epochDayUTC('2026-09-01T00:00:01.000Z')).toBe(epochDayUTC('2026-09-01T23:59:59.000Z'));
  });
  it('counts calendar days across DST-like boundaries', () => {
    expect(epochDayUTC('2026-03-30T00:30:00.000Z') - epochDayUTC('2026-03-28T23:30:00.000Z')).toBe(2);
  });
});

describe('accruedInterest', () => {
  it('same day → 0', () => {
    expect(accruedInterest(rub(100_000), 0.14, NOW, NOW)).toBe(0);
  });
  it('clock moved back → 0, never negative', () => {
    expect(accruedInterest(rub(100_000), 0.14, NOW, '2026-08-25T12:00:00.000Z')).toBe(0);
  });
  it('10 days matches the compound formula exactly', () => {
    const principal = rub(200_000);
    const expected = Math.round(principal * ((1 + 0.14 / 365) ** 10 - 1));
    expect(accruedInterest(principal, 0.14, '2026-08-22T09:00:00.000Z', NOW)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
  it('zero principal → 0', () => {
    expect(accruedInterest(0, 0.14, '2026-08-22T09:00:00.000Z', NOW)).toBe(0);
  });
});

describe('applySettleAccount', () => {
  it('materialises one interest row for the whole missed period and is idempotent same-day', () => {
    const state = buildSeed(NOW);
    const before = transactionsOf(state, SAVINGS_ID).filter((t) => t.kind === 'interest').length;
    const later = '2026-09-11T09:00:00.000Z'; // 10 days after seed
    const settled = applySettleAccount(state, SAVINGS_ID, later);
    const rows = transactionsOf(settled, SAVINGS_ID).filter((t) => t.kind === 'interest');
    expect(rows.length).toBe(before + 1);
    expect(rows[0].amountMinor).toBe(
      accruedInterest(
        balanceOf(state, SAVINGS_ID),
        SAVINGS_APY,
        state.accounts.find((a) => a.id === SAVINGS_ID)!.accrualAnchor!,
        later,
      ),
    );
    // Second settle at the same moment: no extra row.
    const again = applySettleAccount(settled, SAVINGS_ID, later);
    expect(transactionsOf(again, SAVINGS_ID).filter((t) => t.kind === 'interest').length).toBe(
      before + 1,
    );
  });

  it('device clock moved back neither adds a row nor eats anything', () => {
    const state = buildSeed(NOW);
    const balance = balanceOf(state, SAVINGS_ID);
    const rewound = applySettleAccount(state, SAVINGS_ID, '2026-07-01T09:00:00.000Z');
    expect(balanceOf(rewound, SAVINGS_ID)).toBe(balance);
    expect(rewound.transactions.length).toBe(state.transactions.length);
  });
});
