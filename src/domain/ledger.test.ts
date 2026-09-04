import { describe, expect, it } from 'vitest';
import { buildSeed } from './seed';
import { appendRow } from './ledger';
import type { BankState } from './types';

const NOW = '2026-09-01T12:00:00.000Z';

function rowFor(state: BankState, amountMinor: number) {
  return {
    accountId: state.accounts[0].id,
    amountMinor,
    kind: 'topup' as const,
    createdAt: NOW,
  };
}

function stateWithBalance(balanceAfterMinor: number): BankState {
  const state = buildSeed(NOW);
  const accountId = state.accounts[0].id;
  return {
    ...state,
    transactions: [
      {
        id: 'tx_1',
        accountId,
        seq: 1,
        amountMinor: balanceAfterMinor,
        balanceAfterMinor,
        kind: 'seed',
        createdAt: NOW,
      },
    ],
    nextSeq: 2,
  };
}

describe('appendRow', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10.5, 2 ** 53])(
    'rejects an unsafe amountMinor: %s',
    (amountMinor) => {
      const state = buildSeed(NOW);
      const transactionsBefore = state.transactions;

      expect(() => appendRow(state, rowFor(state, amountMinor))).toThrowError(
        new RangeError('Transaction amount must be a safe integer'),
      );
      expect(state.transactions).toBe(transactionsBefore);
    },
  );

  it('rejects a resulting balance outside the safe integer range', () => {
    const state = stateWithBalance(Number.MAX_SAFE_INTEGER);
    const transactionsBefore = state.transactions;

    expect(() => appendRow(state, rowFor(state, 1))).toThrowError(
      new RangeError('Resulting balance must be a safe integer'),
    );
    expect(state.transactions).toBe(transactionsBefore);
  });

  it('rejects an exhausted nextSeq before creating an unsafe successor', () => {
    const base = buildSeed(NOW);
    const state = { ...base, nextSeq: Number.MAX_SAFE_INTEGER };

    expect(() => appendRow(state, rowFor(state, 1))).toThrowError(
      new RangeError('Transaction sequence is exhausted'),
    );
    expect(state.transactions).toBe(base.transactions);
  });
});
