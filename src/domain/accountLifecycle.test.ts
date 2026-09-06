import { describe, expect, it } from 'vitest';
import { applyAddAccount, applyCloseAccount, applyRestoreAccount } from './accountLifecycle';
import { applyBalanceAdjustment } from './manualTransactions';
import { buildSeed, CHECKING_ID } from './seed';
import { balanceOf } from './ledger';

const NOW = '2026-09-05T12:00:00.000Z';

describe('account lifecycle', () => {
  it('adds a zero-balance checking account through a ledger row', () => {
    const state = buildSeed(NOW);
    const outcome = applyAddAccount(state, {
      accountId: 'acc_gel_custom',
      currency: 'GEL',
      name: 'Georgia',
      number: 'CM05GEL000000000005',
      nowISO: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.accounts.at(-1)).toMatchObject({
      id: 'acc_gel_custom',
      type: 'checking',
      role: 'custom',
      status: 'active',
      currency: 'GEL',
    });
    expect(outcome.state.transactions.at(-1)).toMatchObject({
      accountId: 'acc_gel_custom',
      kind: 'seed',
      amountMinor: 0,
      balanceAfterMinor: 0,
    });
  });

  it('rejects another active checking account in the same currency', () => {
    const state = buildSeed(NOW);
    expect(
      applyAddAccount(state, {
        accountId: 'acc_kzt_extra',
        currency: 'KZT',
        name: 'Extra',
        number: 'CM05KZT000000000005',
        nowISO: NOW,
      }),
    ).toEqual({ ok: false, error: 'duplicate_currency' });
  });

  it('closes only at zero, preserves manual card freeze, and restores automatic state', () => {
    const seed = buildSeed(NOW);
    expect(applyCloseAccount(seed, CHECKING_ID, NOW)).toEqual({
      ok: false,
      error: 'non_zero_balance',
    });
    const zeroed = applyBalanceAdjustment(seed, {
      accountId: CHECKING_ID,
      targetAmountInput: '0',
      locale: 'en',
      nowISO: NOW,
    });
    if (!zeroed.ok) throw new Error(zeroed.error);
    const manuallyFrozen = {
      ...zeroed.state,
      cards: zeroed.state.cards.map((card) =>
        card.accountId === CHECKING_ID
          ? { ...card, status: 'frozen' as const, freezeReason: 'manual' as const }
          : card,
      ),
    };
    const closed = applyCloseAccount(manuallyFrozen, CHECKING_ID, NOW);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.state.accounts.find((account) => account.id === CHECKING_ID)).toMatchObject({
      status: 'closed',
      closedAt: NOW,
    });
    expect(balanceOf(closed.state, CHECKING_ID)).toBe(0);
    expect(closed.state.cards.find((card) => card.accountId === CHECKING_ID)).toMatchObject({
      status: 'frozen',
      freezeReason: 'manual',
    });
    const restored = applyRestoreAccount(closed.state, CHECKING_ID, NOW);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.accounts.find((account) => account.id === CHECKING_ID)).toMatchObject({
      status: 'active',
    });
    expect(restored.state.accounts.find((account) => account.id === CHECKING_ID)).not.toHaveProperty(
      'closedAt',
    );
    expect(restored.state.cards.find((card) => card.accountId === CHECKING_ID)).toMatchObject({
      status: 'frozen',
      freezeReason: 'manual',
    });
  });

  it('does not restore a closed checking account over a replacement in the same currency', () => {
    const seed = buildSeed(NOW);
    const zeroed = applyBalanceAdjustment(seed, {
      accountId: CHECKING_ID,
      targetAmountInput: '0',
      locale: 'en',
      nowISO: NOW,
    });
    if (!zeroed.ok) throw new Error(zeroed.error);
    const closed = applyCloseAccount(zeroed.state, CHECKING_ID, NOW);
    if (!closed.ok) throw new Error(closed.error);
    const replacement = applyAddAccount(closed.state, {
      accountId: 'acc_kzt_replacement',
      currency: 'KZT',
      name: 'New current',
      number: 'CM05KZT000000000005',
      nowISO: NOW,
    });
    if (!replacement.ok) throw new Error(replacement.error);

    expect(applyRestoreAccount(replacement.state, CHECKING_ID, NOW)).toEqual({
      ok: false,
      error: 'duplicate_currency',
    });
  });
});
