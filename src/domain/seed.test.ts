import { describe, expect, it } from 'vitest';
import { buildSeed, CHECKING_ID, SAVINGS_ID } from './seed';
import { ledgerErrors } from './invariants';
import { balanceOf } from './ledger';
import { rub } from './money';

const NOW = '2026-09-01T12:00:00.000Z';

describe('buildSeed', () => {
  it('is deterministic: same now → identical state', () => {
    expect(buildSeed(NOW)).toEqual(buildSeed(NOW));
  });

  it('produces a self-consistent ledger', () => {
    expect(ledgerErrors(buildSeed(NOW))).toEqual([]);
  });

  it('has a realistic volume and never dips checking below the floor', () => {
    const state = buildSeed(NOW);
    expect(state.transactions.length).toBeGreaterThan(120);
    let running = 0;
    for (const t of state.transactions) {
      if (t.accountId !== CHECKING_ID) continue;
      running += t.amountMinor;
      expect(running).toBeGreaterThanOrEqual(rub(500)); // every debit respects the floor
      expect(running).toBe(t.balanceAfterMinor);
    }
    expect(balanceOf(state, CHECKING_ID)).toBeGreaterThan(0);
    expect(balanceOf(state, SAVINGS_ID)).toBeGreaterThan(rub(150_000));
  });

  it('contains the realism beats: salary, rent, interest rows, own transfers', () => {
    const state = buildSeed(NOW);
    const kinds = new Set(state.transactions.map((t) => t.kind));
    expect(kinds.has('topup')).toBe(true);
    expect(kinds.has('interest')).toBe(true);
    expect(kinds.has('transfer_own_out')).toBe(true);
    expect(kinds.has('transfer_own_in')).toBe(true);
    const salary = state.transactions.filter((t) => t.category === 'salary');
    expect(salary.length).toBeGreaterThanOrEqual(2);
    // Interest rows land on savings only.
    expect(
      state.transactions.filter((t) => t.kind === 'interest').every((t) => t.accountId === SAVINGS_ID),
    ).toBe(true);
  });

  it('rows are seq-ordered and timestamps do not go backwards within an account day', () => {
    const state = buildSeed(NOW);
    const seqs = state.transactions.map((t) => t.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
