import { describe, expect, it } from 'vitest';
import { applyTransfer, type TransferInput } from './transfer';
import { balanceOf } from './ledger';
import { ledgerErrors } from './invariants';
import { accruedInterest, applySettleAll } from './interest';
import { rub } from './money';
import type { BankState, Currency, ExchangeRateSnapshot } from './types';

const NOW = '2026-09-01T12:00:00.000Z';
const LATER_SAME_DAY = '2026-09-01T12:05:00.000Z';
const CHECKING_ID = 'acc_checking';
const SAVINGS_ID = 'acc_savings';

const EXCHANGE_RATES: ExchangeRateSnapshot = {
  base: 'USD',
  asOf: '2026-09-01',
  fetchedAt: '2026-09-01T08:00:00.000Z',
  source: 'frankfurter',
  rates: {
    USD: '1',
    EUR: '0.85',
    RUB: '90.5',
    KZT: '500',
    THB: '35',
    VND: '25000',
    IDR: '16000',
    GEL: '2.7',
  },
};

function seeded(
  checkingCurrency: Currency = 'RUB',
  savingsCurrency: Currency = 'RUB',
): BankState {
  return {
    primaryCurrency: checkingCurrency,
    exchangeRates: EXCHANGE_RATES,
    accounts: [
      {
        id: CHECKING_ID,
        type: 'checking',
        name: 'Текущий',
        currency: checkingCurrency,
        number: '40817810200001548753',
        createdAt: NOW,
      },
      {
        id: SAVINGS_ID,
        type: 'savings',
        name: 'Накопительный',
        currency: savingsCurrency,
        number: '42301810900002013416',
        apy: 0.14,
        accrualAnchor: NOW,
        createdAt: NOW,
      },
    ],
    transactions: [
      {
        id: 'tx_1',
        accountId: CHECKING_ID,
        seq: 1,
        amountMinor: rub(1_000_000),
        balanceAfterMinor: rub(1_000_000),
        kind: 'seed',
        createdAt: NOW,
      },
      {
        id: 'tx_2',
        accountId: SAVINGS_ID,
        seq: 2,
        amountMinor: rub(2_000_000),
        balanceAfterMinor: rub(2_000_000),
        kind: 'seed',
        createdAt: NOW,
      },
    ],
    cards: [],
    contacts: ['Аня', 'Дима', 'Мама', 'Ромик', 'Янис'].map((name, index) => ({
      id: `c_${index + 1}`,
      name,
      initials: name.slice(0, 1),
    })),
    profile: { displayName: 'Никита' },
    nextSeq: 3,
    recentTransferIds: [],
  };
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
    expect(out.applied).toBe(true);
    expect(out.incomingAmountMinor).toBe(rub(10_000));
    expect(balanceOf(out.state, CHECKING_ID) + balanceOf(out.state, SAVINGS_ID)).toBe(total);
    expect(balanceOf(out.state, CHECKING_ID)).toBe(balanceOf(state, CHECKING_ID) - rub(10_000));
    const legs = out.state.transactions.slice(-2);
    expect(legs[0].transferGroupId).toBeDefined();
    expect(legs[0].transferGroupId).toBe(legs[1].transferGroupId);
    expect(legs[0]).not.toHaveProperty('fxSnapshot');
    expect(legs[1]).not.toHaveProperty('fxSnapshot');
    expect(ledgerErrors(out.state)).toEqual([]);
  });

  it('converts a cross-currency transfer and captures one immutable FX snapshot', () => {
    const state = applySettleAll(seeded('EUR', 'RUB'), LATER_SAME_DAY);
    const sourceBefore = balanceOf(state, CHECKING_ID);
    const targetBefore = balanceOf(state, SAVINGS_ID);
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 8_500,
      clientTransferId: 'ct_fx_cross',
      nowISO: LATER_SAME_DAY,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.applied).toBe(true);
    expect(out.incomingAmountMinor).toBe(905_000);
    expect(balanceOf(out.state, CHECKING_ID)).toBe(sourceBefore - 8_500);
    expect(balanceOf(out.state, SAVINGS_ID)).toBe(targetBefore + 905_000);
    const [outgoing, incoming] = out.state.transactions.slice(-2);
    expect(outgoing.amountMinor).toBe(-8_500);
    expect(incoming.amountMinor).toBe(905_000);
    expect(outgoing.fxSnapshot).toBe(incoming.fxSnapshot);
    expect(Object.isFrozen(outgoing.fxSnapshot)).toBe(true);
    expect(outgoing.fxSnapshot).toEqual({
      fromCurrency: 'EUR',
      toCurrency: 'RUB',
      fromAmountMinor: 8_500,
      toAmountMinor: 905_000,
      rate: '106.470588235294117647',
      fromUsdRate: EXCHANGE_RATES.rates.EUR,
      toUsdRate: EXCHANGE_RATES.rates.RUB,
      asOf: EXCHANGE_RATES.asOf,
      fetchedAt: EXCHANGE_RATES.fetchedAt,
      source: EXCHANGE_RATES.source,
    });
    expect(ledgerErrors(out.state)).toEqual([]);
  });

  it('rejects an invalid exchange rate without ledger mutation', () => {
    const base = seeded('USD', 'RUB');
    const state: BankState = {
      ...base,
      exchangeRates: {
        ...base.exchangeRates,
        rates: { ...base.exchangeRates.rates, RUB: 'not-a-rate' },
      },
    };
    const transactionsBefore = state.transactions;
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 10_000,
      clientTransferId: 'ct_fx_invalid',
      nowISO: LATER_SAME_DAY,
    });

    expect(out).toEqual({ ok: false, error: 'invalid_exchange_rate' });
    expect(state.transactions).toBe(transactionsBefore);
    expect(state.nextSeq).toBe(base.nextSeq);
  });

  it('rejects a converted amount rounded to zero without ledger mutation', () => {
    const base = seeded('USD', 'EUR');
    const state: BankState = {
      ...base,
      exchangeRates: {
        ...base.exchangeRates,
        rates: { ...base.exchangeRates.rates, EUR: '0.001' },
      },
    };
    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 1,
      clientTransferId: 'ct_fx_dust',
      nowISO: LATER_SAME_DAY,
    });

    expect(out).toEqual({ ok: false, error: 'converted_amount_too_small' });
    expect(state.recentTransferIds).not.toContain('ct_fx_dust');
  });

  it('replays a cross-currency clientTransferId before reading changed rates', () => {
    const first = applyTransfer(seeded('EUR', 'RUB'), {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 8_500,
      clientTransferId: 'ct_fx_duplicate',
      nowISO: LATER_SAME_DAY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const stateWithBrokenRates: BankState = {
      ...first.state,
      exchangeRates: {
        ...first.state.exchangeRates,
        rates: { ...first.state.exchangeRates.rates, RUB: 'broken-after-first-submit' },
      },
    };
    const replay = applyTransfer(stateWithBrokenRates, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 8_500,
      clientTransferId: 'ct_fx_duplicate',
      nowISO: LATER_SAME_DAY,
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.state).toBe(stateWithBrokenRates);
    expect(replay.applied).toBe(false);
    expect(replay.incomingAmountMinor).toBeUndefined();
  });

  it('marks an idempotent replay without borrowing a later transfer receipt', () => {
    const input = {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: rub(10),
      clientTransferId: 'ct_receipt_once',
      nowISO: LATER_SAME_DAY,
    };
    const first = applyTransfer(seeded(), input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const interleaved = applyTransfer(first.state, {
      ...input,
      amountMinor: rub(20),
      clientTransferId: 'ct_receipt_later',
    });
    expect(interleaved.ok).toBe(true);
    if (!interleaved.ok) return;

    const replay = applyTransfer(interleaved.state, input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.applied).toBe(false);
    expect(replay.incomingAmountMinor).toBeUndefined();
    expect(replay.state).toBe(interleaved.state);
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

  it('rejects a target balance overflow without committing either transfer leg', () => {
    const base = seeded();
    const state: BankState = {
      ...base,
      transactions: base.transactions.map((transaction) =>
        transaction.accountId === SAVINGS_ID
          ? {
              ...transaction,
              amountMinor: Number.MAX_SAFE_INTEGER,
              balanceAfterMinor: Number.MAX_SAFE_INTEGER,
            }
          : transaction,
      ),
    };
    const transactionsBefore = state.transactions;

    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: 1,
      clientTransferId: 'ct_balance_overflow',
      nowISO: LATER_SAME_DAY,
    });

    expect(out).toEqual({ ok: false, error: 'balance_overflow' });
    expect(state.transactions).toBe(transactionsBefore);
    expect(state.nextSeq).toBe(base.nextSeq);
    expect(state.recentTransferIds).not.toContain('ct_balance_overflow');
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

  it('rejects a malformed clientTransferId before mutating the ledger', () => {
    const state = seeded();
    const transactionsBefore = state.transactions;

    const out = applyTransfer(state, {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      amountMinor: rub(100),
      clientTransferId: '   ',
      nowISO: LATER_SAME_DAY,
    });

    expect(out).toEqual({ ok: false, error: 'invalid_client_transfer_id' });
    expect(state.transactions).toBe(transactionsBefore);
    expect(state.recentTransferIds).toEqual([]);
  });

  it('rejects ambiguous dual targets without mutating the ledger', () => {
    const state = seeded();
    const transactionsBefore = state.transactions;
    const ambiguous = {
      fromAccountId: CHECKING_ID,
      toAccountId: SAVINGS_ID,
      toContactId: state.contacts[0].id,
      amountMinor: rub(100),
      clientTransferId: 'ct_ambiguous_target',
      nowISO: LATER_SAME_DAY,
    } as unknown as TransferInput;

    const out = applyTransfer(state, ambiguous);

    expect(out).toEqual({ ok: false, error: 'unknown_target' });
    expect(state.transactions).toBe(transactionsBefore);
    expect(state.recentTransferIds).toEqual([]);
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
