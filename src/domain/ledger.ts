import type { BankState, Money, Transaction } from './types';

/**
 * Account balance = balanceAfterMinor of the account's last ledger row.
 * No separately mutated balance field exists, so balance/history drift is
 * structurally impossible (docs/spec.md §5.2).
 */
export function balanceOf(state: Pick<BankState, 'transactions'>, accountId: string): Money {
  const txs = state.transactions;
  for (let i = txs.length - 1; i >= 0; i--) {
    if (txs[i].accountId === accountId) return txs[i].balanceAfterMinor;
  }
  return 0;
}

/** Ledger rows of one account, newest first. */
export function transactionsOf(
  state: Pick<BankState, 'transactions'>,
  accountId: string,
): Transaction[] {
  return state.transactions.filter((t) => t.accountId === accountId).reverse();
}

/** Append a row, stamping seq and the running balance snapshot. */
export function appendRow(
  state: BankState,
  row: Omit<Transaction, 'seq' | 'balanceAfterMinor' | 'id'>,
): BankState {
  const balance = balanceOf(state, row.accountId) + row.amountMinor;
  const tx: Transaction = {
    ...row,
    id: `tx_${state.nextSeq}`,
    seq: state.nextSeq,
    balanceAfterMinor: balance,
  };
  return {
    ...state,
    transactions: [...state.transactions, tx],
    nextSeq: state.nextSeq + 1,
  };
}
