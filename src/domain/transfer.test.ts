import { describe, expect, it } from 'vitest';
import { applyTransfer } from './transfer';
import { buildSeed, CHECKING_ID, SAVINGS_ID } from './seed';
import { balanceOf } from './ledger';
import { ledgerErrors } from './invariants';
import { accruedInterest, applySettleAll } from './interest';
import { rub } from './money';

const NOW = '2026-09-01T12:00:00.000Z';
const LATER_SAME_DAY = '2026-09-01T12:05:00.000Z';

function seeded() {
  return buildSeed(NOW);
}

describe('applyTransfer — own accounts', () => {
  it('moves money, keeps the total unchanged, links both legs with one group id', () => {
    // Pre-settle at the same moment so the in-transfer settle is a no-op and
    // the transfer itself must conserve the total exactly.
    const state = applySettleAll(seeded(), LATER_SAME_DAY);
    const total = balanceOf(state, CHECKING_ID) + balanceOf(state, SAVINGS_ID);
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: rub(10_000),
      clientTransferId: 'ct_1',
      nowISO: LATER_SAME_DAY,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(balanceOf(out.state, CHECKING_ID) + balanceOf(out.state, SAVINGS_ID)).toBe(total);
    expect(balanceOf(out.state, CHECKING_ID)).toBe(balanceOf(state, CHECKING_ID) - rub(10_000));
    const legs = out.state.transactions.slice(-2);
    expect(legs[0].transferGroupId).toBeDefined();
    expect(legs[0].transferGroupId).toBe(legs[1].transferGroupId);
    expect(ledgerErrors(out.state)).toEqual([]);
  });

  it('rejects insufficient funds without any mutation', () => {
    const state = seeded();
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: balanceOf(state, CHECKING_ID) + rub(1),
      clientTransferId: 'ct_2',
      nowISO: LATER_SAME_DAY,
    });
    expect(out).toEqual({ ok: false, error: 'insufficient_funds' });
    expect(state.transactions.length).toBe(seeded().transactions.length);
  });

  it('rejects non-positive and non-integer amounts', () => {
    const state = seeded();
    for (const amountMinor of [0, -100, 10.5]) {
      const out = applyTransfer(state, {
        fromAccountId: CHECKING_ID,
        toAccountId: SAVINGS_ID,
        amountMinor,
        clientTransferId: `ct_bad_${amountMinor}`,
        nowISO: LATER_SAME_DAY,
      });
      expect(out).toEqual({ ok: false, error: 'invalid_amount' });
    }
  });

  it('rejects transfer to the same account', () => {
    const out = applyTransfer(seeded(), {
      fromAccountId: CHECKING_ID,
      toAccountId: CHECKING_ID,
      amountMinor: rub(100),
      clientTransferId: 'ct_3',
      nowISO: LATER_SAME_DAY,
    });
    expect(out).toEqual({ ok: false, error: 'same_account' });
  });

  it('double tap (same clientTransferId) is a successful no-op, not a second debit', () => {
    const state = seeded();
    const first = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: rub(5_000),
      clientTransferId: 'ct_dup',
      nowISO: LATER_SAME_DAY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyTransfer(first.state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: rub(5_000),
      clientTransferId: 'ct_dup',
      nowISO: LATER_SAME_DAY,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.transactions.length).toBe(first.state.transactions.length);
    expect(balanceOf(second.state, CHECKING_ID)).toBe(balanceOf(first.state, CHECKING_ID));
  });

  it('settles pending interest first, so accrued interest covers the transfer', () => {
    const state = seeded();
    const savings = state.accounts.find((a) => a.id === SAVINGS_ID)!;
    const balance = balanceOf(state, SAVINGS_ID);
    const tenDaysLater = '2026-09-11T12:00:00.000Z';
    const pending = accruedInterest(balance, savings.apy!, savings.accrualAnchor!, tenDaysLater);
    expect(pending).toBeGreaterThan(0);
    // More than the visible balance, less than balance + pending interest.
    const out = applyTransfer(state, {
      fromAccountId: SAVINGS_ID,
      toAccountId: CHECKING_ID,
      amountMinor: balance + Math.floor(pending / 2),
      clientTransferId: 'ct_interest',
      nowISO: tenDaysLater,
    });
    expect(out.ok).toBe(true);
  });
});

describe('applyTransfer — contact', () => {
  it('debits only the source and stamps contact.lastTransferAt', () => {
    const state = seeded();
    const savingsBefore = balanceOf(state, SAVINGS_ID);
    const contact = state.contacts[4];
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toContactId: contact.id,
      amountMinor: rub(1_500),
      clientTransferId: 'ct_4',
      nowISO: LATER_SAME_DAY,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(balanceOf(out.state, CHECKING_ID)).toBe(balanceOf(state, CHECKING_ID) - rub(1_500));
    expect(balanceOf(out.state, SAVINGS_ID)).toBe(savingsBefore);
    expect(out.state.contacts.find((c) => c.id === contact.id)!.lastTransferAt).toBe(LATER_SAME_DAY);
    const last = out.state.transactions[out.state.transactions.length - 1];
    expect(last.kind).toBe('transfer_contact');
    expect(last.counterparty).toBe(contact.name);
  });

  it('unknown target is rejected', () => {
    const out = applyTransfer(seeded(), {
      fromAccountId: CHECKING_ID,
      toContactId: 'c_nope',
      amountMinor: rub(100),
      clientTransferId: 'ct_5',
      nowISO: LATER_SAME_DAY,
    });
    expect(out).toEqual({ ok: false, error: 'unknown_target' });
  });
});
