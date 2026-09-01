import type { BankState } from './types';

/**
 * Ledger self-consistency: per account, every row's snapshot equals the
 * previous snapshot plus its amount (hence balance == sum of amounts).
 */
export function ledgerErrors(state: BankState): string[] {
  const errors: string[] = [];
  const running = new Map<string, number>();
  let lastSeq = -1;
  for (const tx of state.transactions) {
    if (tx.seq <= lastSeq) errors.push(`seq not increasing at ${tx.id}`);
    lastSeq = tx.seq;
    const expected = (running.get(tx.accountId) ?? 0) + tx.amountMinor;
    if (tx.balanceAfterMinor !== expected) {
      errors.push(
        `ledger drift on ${tx.accountId} at seq ${tx.seq}: snapshot ${tx.balanceAfterMinor}, expected ${expected}`,
      );
    }
    running.set(tx.accountId, expected);
    if (!Number.isSafeInteger(tx.amountMinor)) errors.push(`non-integer amount at seq ${tx.seq}`);
  }
  return errors;
}

/** Throws in DEV after each mutation; never runs in PROD (ErrorBoundary's job). */
export function assertLedger(state: BankState): void {
  if (import.meta.env?.DEV) {
    const errors = ledgerErrors(state);
    if (errors.length > 0) throw new Error(`ledger invariant broken:\n${errors.join('\n')}`);
  }
}
