import { describe, expect, it } from 'vitest';
import { SUPPORTED_CURRENCIES } from './currency';
import {
  buildSeed,
  CHECKING_ID,
  SAVINGS_ID,
  STATEMENT_CLOSING_BALANCE_MINOR,
  STATEMENT_OPENING_BALANCE_MINOR,
} from './seed';
import { STATEMENT_ROWS } from './statementData';
import { ledgerErrors } from './invariants';
import { balanceOf } from './ledger';

const NOW = new Date(2026, 8, 1, 23, 59, 59, 999).toISOString();
const CHECKING_FLOOR_MINOR = 5_000_000;
const SAVINGS_OPENING_MINOR = 850_000_000;

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
      expect(running).toBeGreaterThanOrEqual(CHECKING_FLOOR_MINOR);
      expect(running).toBe(t.balanceAfterMinor);
    }
    expect(balanceOf(state, CHECKING_ID)).toBeGreaterThan(0);
    expect(balanceOf(state, SAVINGS_ID)).toBeGreaterThan(SAVINGS_OPENING_MINOR);
  });

  it('seeds exactly two KZT accounts plus one USD and one EUR account', () => {
    const state = buildSeed(NOW);
    const accountIds = new Set(state.accounts.map((account) => account.id));
    const accountNumbers = new Set(state.accounts.map((account) => account.number));

    expect(state.primaryCurrency).toBe('KZT');
    expect(state.accounts.map((account) => account.id)).toEqual([
      CHECKING_ID,
      SAVINGS_ID,
      'acc_usd',
      'acc_eur',
    ]);
    expect(state.accounts.map((account) => account.currency)).toEqual(['KZT', 'KZT', 'USD', 'EUR']);
    expect(accountIds.size).toBe(state.accounts.length);
    expect(accountNumbers.size).toBe(state.accounts.length);
    expect(state.accounts.every((account) => /^KZ[A-Z0-9]{18}$/.test(account.number))).toBe(true);
    for (const account of state.accounts) {
      expect(Number.isSafeInteger(balanceOf(state, account.id))).toBe(true);
      expect(balanceOf(state, account.id)).toBeGreaterThan(0);
      expect(state.transactions.some((transaction) => transaction.accountId === account.id)).toBe(true);
    }

    expect(state.exchangeRates.base).toBe('USD');
    expect(new Set(Object.keys(state.exchangeRates.rates))).toEqual(new Set(SUPPORTED_CURRENCIES));
    for (const rate of Object.values(state.exchangeRates.rates)) {
      expect(Number(rate)).toBeGreaterThan(0);
    }
    expect(state.cards.every((card) => accountIds.has(card.accountId))).toBe(true);
    expect(state.transactions.every((transaction) => accountIds.has(transaction.accountId))).toBe(true);
  });

  it('keeps most money in KZT savings with smaller spending, USD and EUR balances', () => {
    const state = buildSeed(NOW);
    const checking = balanceOf(state, CHECKING_ID);
    const savings = balanceOf(state, SAVINGS_ID);
    const usd = balanceOf(state, 'acc_usd');
    const eur = balanceOf(state, 'acc_eur');

    expect(checking).toBe(61_595_957);
    expect(savings).toBe(990_379_726);
    expect(savings).toBeGreaterThan(checking * 15);
    expect(usd).toBe(80_000);
    expect(eur).toBe(40_000);
  });

  it('never timestamps a frozen FX rate after its seeded conversion', () => {
    const environment = (
      globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
      }
    ).process?.env;
    if (environment === undefined) throw new Error('test runtime has no process environment');
    const originalTimeZone = environment.TZ;
    try {
      for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        environment.TZ = timeZone;
        const fxLegs = buildSeed(NOW).transactions.filter(
          (transaction) => transaction.fxSnapshot !== undefined,
        );

        expect(fxLegs.length).toBeGreaterThan(0);
        for (const transaction of fxLegs) {
          expect(Date.parse(transaction.fxSnapshot!.fetchedAt)).toBeLessThanOrEqual(
            Date.parse(transaction.createdAt),
          );
        }
      }
    } finally {
      if (originalTimeZone === undefined) delete environment.TZ;
      else environment.TZ = originalTimeZone;
    }
  });

  it('preserves the complete sanitized statement and its certified closing balance', () => {
    const state = buildSeed(NOW);
    const statementNetMinor = STATEMENT_ROWS.reduce(
      (sum, transaction) => sum + transaction.amountMinor,
      0,
    );
    const statementPurchases = STATEMENT_ROWS.filter(
      (transaction) =>
        transaction.kind === 'purchase' &&
        transaction.counterparty !== 'Снятие наличных' &&
        transaction.counterparty !== 'Комиссия банка',
    );
    const reconciliation = state.transactions.find(
      (transaction) => transaction.counterparty === 'Сверка итогового баланса',
    );

    expect(STATEMENT_ROWS).toHaveLength(369);
    expect(statementNetMinor).toBe(-1_021_747_388);
    expect(statementPurchases).toHaveLength(298);
    expect(
      statementPurchases.reduce((sum, transaction) => sum + transaction.amountMinor, 0),
    ).toBe(-526_214_177);
    expect(reconciliation?.amountMinor).toBe(457_126);
    expect(reconciliation?.balanceAfterMinor).toBe(STATEMENT_CLOSING_BALANCE_MINOR);
    expect(STATEMENT_OPENING_BALANCE_MINOR + statementNetMinor + 457_126).toBe(
      STATEMENT_CLOSING_BALANCE_MINOR,
    );
  });

  it('propagates the statement pending status into the built ledger', () => {
    const pendingRows = buildSeed(NOW).transactions.filter(
      (transaction) => transaction.status === 'pending',
    );

    expect(pendingRows).toEqual([
      expect.objectContaining({
        amountMinor: -1_143_482,
        kind: 'purchase',
        counterparty: 'ChatGPT',
      }),
    ]);
    const pendingDate = new Date(pendingRows[0].createdAt);
    expect([pendingDate.getFullYear(), pendingDate.getMonth() + 1, pendingDate.getDate()]).toEqual([
      2026, 6, 19,
    ]);
  });

  it('continues the real merchant pattern after the statement and allocates the portfolio', () => {
    const state = buildSeed(NOW);
    const kinds = new Set(state.transactions.map((t) => t.kind));
    expect(kinds.has('topup')).toBe(true);
    expect(kinds.has('purchase')).toBe(true);
    expect(kinds.has('interest')).toBe(true);
    expect(kinds.has('transfer_own_out')).toBe(true);
    expect(kinds.has('transfer_own_in')).toBe(true);
    expect(
      state.transactions.filter(
        (transaction) =>
          transaction.counterparty === 'ChatGPT' && transaction.createdAt >= '2026-07-01',
      ),
    ).toHaveLength(2);
    expect(
      state.transactions.filter(
        (transaction) =>
          transaction.counterparty === 'Spotify' && transaction.createdAt >= '2026-07-01',
      ),
    ).toHaveLength(2);
    // Interest rows land on savings only.
    expect(
      state.transactions.filter((t) => t.kind === 'interest').every((t) => t.accountId === SAVINGS_ID),
    ).toBe(true);
    expect(JSON.stringify([state.contacts, state.transactions])).not.toMatch(/kaspi|kaspy/i);

    const statementCounterparties = STATEMENT_ROWS.map((transaction) => transaction.counterparty);
    expect(statementCounterparties.join('\n')).not.toMatch(
      /\b(?:iin|iban|account|card|statement(?:\s+no)?)\b|(?:\d[\s-]*){10,}/i,
    );
    expect(
      new Set(
        STATEMENT_ROWS.filter((transaction) => transaction.kind === 'transfer_contact').map(
          (transaction) => transaction.counterparty,
        ),
      ),
    ).toEqual(
      new Set(['Перевод контакту', 'В прежний накопительный', 'Из прежнего накопительного']),
    );
    const localizedStatementLabels = new Set([
      'Перевод контакту',
      'В прежний накопительный',
      'Из прежнего накопительного',
      'Пополнение с внешнего счёта',
      'Снятие наличных',
      'Комиссия банка',
    ]);
    expect(
      statementCounterparties.filter((counterparty) => /[А-Яа-яЁё]/.test(counterparty)),
    ).toEqual(expect.arrayContaining([...localizedStatementLabels]));
    expect(
      statementCounterparties
        .filter((counterparty) => /[А-Яа-яЁё]/.test(counterparty))
        .every((counterparty) => localizedStatementLabels.has(counterparty)),
    ).toBe(true);
  });

  it('appends every row in global timestamp order and never seeds past now', () => {
    const state = buildSeed(NOW);
    const nowTimestamp = Date.parse(NOW);

    for (const [index, transaction] of state.transactions.entries()) {
      const timestamp = Date.parse(transaction.createdAt);
      expect(transaction.seq).toBe(index + 1);
      expect(timestamp).toBeLessThanOrEqual(nowTimestamp);
      if (index > 0) {
        expect(timestamp).toBeGreaterThanOrEqual(Date.parse(state.transactions[index - 1].createdAt));
      }
    }
  });

  it('stores merchant purchases at the local wall-clock hours rendered by the UI', () => {
    const merchantPurchases = buildSeed(NOW).transactions.filter(
      (transaction) =>
        transaction.kind === 'purchase' &&
        transaction.category !== 'home' &&
        transaction.category !== 'subscriptions',
    );

    expect(merchantPurchases.length).toBeGreaterThan(100);
    for (const transaction of merchantPurchases) {
      const displayedHour = new Date(transaction.createdAt).getHours();
      expect(displayedHour).toBeGreaterThanOrEqual(8);
      expect(displayedHour).toBeLessThan(23);
    }
  });

  it('backs recent contacts with outgoing transfers inserted oldest first', () => {
    const state = buildSeed(NOW);
    const recentContacts = state.contacts.filter((contact) => contact.lastTransferAt);
    const recentFirst = [...recentContacts].sort((a, b) =>
      b.lastTransferAt!.localeCompare(a.lastTransferAt!),
    );

    expect(recentFirst.map((contact) => contact.name)).toEqual(['Данияр', 'Руслан', 'Айдана']);

    const rowsBySeq = recentContacts
      .map((contact) =>
        state.transactions.find(
          (transaction) =>
            transaction.kind === 'transfer_contact' &&
            transaction.amountMinor < 0 &&
            transaction.counterparty === contact.name &&
            transaction.createdAt === contact.lastTransferAt,
        ),
      )
      .filter((transaction) => transaction !== undefined)
      .sort((a, b) => a.seq - b.seq);

    expect(rowsBySeq).toHaveLength(3);
    expect(rowsBySeq.map((transaction) => transaction.counterparty)).toEqual([
      'Айдана',
      'Руслан',
      'Данияр',
    ]);
  });
});
