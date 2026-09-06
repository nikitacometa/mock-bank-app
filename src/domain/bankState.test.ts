import { describe, expect, it } from 'vitest';
import { applyCloseAccount } from './accountLifecycle';
import { canonicalBankStateJson, migrateBankStateV4, parseBankState } from './bankState';
import { applyBalanceAdjustment } from './manualTransactions';
import { createRecurringRule } from './recurring';
import { buildSeed, CHECKING_ID, SAVINGS_ID } from './seed';
import { appendRow, balanceOf } from './ledger';
import type { RecurringRule, Transaction } from './types';

const NOW = '2026-09-05T12:00:00.000Z';

function mutable<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('BankState v5 boundary', () => {
  it('strictly projects a valid v5 state and binds an expected Telegram ID', () => {
    const state = { ...buildSeed(NOW), profile: { displayName: 'Ada', telegramId: '42' } };
    expect(parseBankState({ ...state, injectedAction: 'nope' }, NOW, { expectedTelegramId: '42' })).toEqual(state);
    expect(parseBankState(state, NOW, { expectedTelegramId: '43' })).toBeNull();
  });

  it('migrates v4 without reseeding transactions, balances, or a manual card freeze', () => {
    const state = mutable(buildSeed(NOW));
    delete state.demoBaseCurrency;
    delete state.fixtureId;
    delete state.recurringRules;
    for (const account of state.accounts as Record<string, unknown>[]) {
      delete account.role;
      delete account.status;
    }
    const cards = state.cards as Record<string, unknown>[];
    cards[0] = { ...cards[0], status: 'frozen' };
    const beforeTransactions = state.transactions;

    const migrated = migrateBankStateV4(state, NOW);
    expect(migrated).not.toBeNull();
    expect(migrated?.transactions).toEqual(beforeTransactions);
    expect(migrated?.demoBaseCurrency).toBe('KZT');
    expect(migrated?.fixtureId).toBe('owner-kzt-v1');
    expect(migrated?.recurringRules).toEqual([]);
    expect(migrated?.cards[0]).toMatchObject({ status: 'frozen', freezeReason: 'manual' });
  });

  it('rejects a fixture identity that does not match its base currency', () => {
    const state = { ...buildSeed(NOW), fixtureId: 'synthetic-thb-v1' as const };
    expect(parseBankState(state, NOW)).toBeNull();
  });

  it('rejects exchange-rate decimals above the bounded parser length', () => {
    const state = buildSeed(NOW);
    const unboundedRate = {
      ...state,
      exchangeRates: {
        ...state.exchangeRates,
        rates: { ...state.exchangeRates.rates, EUR: '9'.repeat(65) },
      },
    };

    expect(parseBankState(unboundedRate, NOW)).toBeNull();
  });

  it('rejects account roles that contradict their account type', () => {
    const state = buildSeed(NOW);
    const swappedPrimaryRoles = {
      ...state,
      accounts: state.accounts.map((account) => {
        if (account.role === 'primary-checking') {
          return { ...account, role: 'primary-savings' as const };
        }
        if (account.role === 'primary-savings') {
          return { ...account, role: 'primary-checking' as const };
        }
        return account;
      }),
    };
    const companionSavings = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.role === 'companion-1'
          ? {
              ...account,
              type: 'savings' as const,
              apy: 0.01,
              accrualAnchor: account.createdAt,
            }
          : account,
      ),
    };

    expect(parseBankState(swappedPrimaryRoles, NOW)).toBeNull();
    expect(parseBankState(companionSavings, NOW)).toBeNull();
  });

  it('binds primary and companion role currencies to the fixture template', () => {
    const state = buildSeed(NOW, 'THB');
    const wrongPrimaryCurrency = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.role === 'primary-savings' ? { ...account, currency: 'GEL' as const } : account,
      ),
    };
    const swappedCompanionRoles = {
      ...state,
      accounts: state.accounts.map((account) => {
        if (account.role === 'companion-1') return { ...account, role: 'companion-2' as const };
        if (account.role === 'companion-2') return { ...account, role: 'companion-1' as const };
        return account;
      }),
    };

    expect(parseBankState(wrongPrimaryCurrency, NOW)).toBeNull();
    expect(parseBankState(swappedCompanionRoles, NOW)).toBeNull();
  });

  it('rejects duplicate currencies among active checking accounts', () => {
    const state = buildSeed(NOW);
    const duplicateUsd = {
      ...state,
      accounts: [
        ...state.accounts,
        {
          id: 'acc_duplicate_usd',
          type: 'checking' as const,
          role: 'custom' as const,
          status: 'active' as const,
          name: 'Duplicate USD',
          currency: 'USD' as const,
          number: 'CM05USD000000000005',
          createdAt: NOW,
        },
      ],
    };

    expect(parseBankState(duplicateUsd, NOW)).toBeNull();
  });

  it('rejects future account creation and closure by actual instant', () => {
    const state = buildSeed(NOW);
    const futureInstantWithEarlierWallClock = '2026-09-05T11:30:00-01:00';
    const futureAccount = {
      ...state,
      accounts: [
        ...state.accounts,
        {
          id: 'acc_future_gel',
          type: 'checking' as const,
          role: 'custom' as const,
          status: 'active' as const,
          name: 'Future GEL',
          currency: 'GEL' as const,
          number: 'CM05GEL000000000005',
          createdAt: futureInstantWithEarlierWallClock,
        },
      ],
    };
    const customAccount = {
      id: 'acc_closed_gel',
      type: 'checking' as const,
      role: 'custom' as const,
      status: 'active' as const,
      name: 'Closed GEL',
      currency: 'GEL' as const,
      number: 'CM05GEL000000000006',
      createdAt: '2026-09-05T10:00:00.000Z',
    };
    const withOpening = appendRow(
      { ...state, accounts: [...state.accounts, customAccount] },
      {
        accountId: customAccount.id,
        amountMinor: 0,
        kind: 'seed',
        counterparty: 'Account opened',
        category: 'other',
        effectiveDate: '2026-09-05',
        createdAt: customAccount.createdAt,
      },
    );
    const futureClosure = {
      ...withOpening,
      accounts: withOpening.accounts.map((account) =>
        account.id === customAccount.id
          ? {
              ...account,
              status: 'closed' as const,
              closedAt: futureInstantWithEarlierWallClock,
            }
          : account,
      ),
    };

    expect(Date.parse(futureInstantWithEarlierWallClock)).toBeGreaterThan(Date.parse(NOW));
    expect(parseBankState(futureAccount, NOW)).toBeNull();
    expect(parseBankState(futureClosure, NOW)).toBeNull();
  });

  it('rejects future transaction and recurrence creation by actual instant', () => {
    const state = buildSeed(NOW);
    const futureInstantWithEarlierWallClock = '2026-09-05T11:30:00-01:00';
    const futureTransaction = appendRow(state, {
      accountId: CHECKING_ID,
      amountMinor: 100,
      kind: 'manual_income',
      counterparty: 'Future append',
      category: 'other',
      effectiveDate: '2026-09-05',
      createdAt: futureInstantWithEarlierWallClock,
    });
    const futureRule: RecurringRule = {
      id: 'rr_future_created',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountMinor: 1_000,
      counterparty: 'Future-created subscription',
      category: 'subscriptions',
      cadence: 'monthly',
      anchorDay: 30,
      startsOn: '2026-09-30',
      nextOccurrence: '2026-09-30',
      status: 'active',
      createdAt: futureInstantWithEarlierWallClock,
    };

    expect(Date.parse(futureInstantWithEarlierWallClock)).toBeGreaterThan(Date.parse(NOW));
    expect(parseBankState(futureTransaction, NOW)).toBeNull();
    expect(parseBankState({ ...state, recurringRules: [futureRule] }, NOW)).toBeNull();
  });

  it('rejects future immutable metadata outside the top-level event timestamps', () => {
    const state = buildSeed(NOW);
    const futureTimestamp = '2026-09-06T00:00:00.000Z';
    const savingsAnchor = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.type === 'savings'
          ? { ...account, accrualAnchor: futureTimestamp }
          : account,
      ),
    };
    const futureRates = {
      ...state,
      exchangeRates: {
        ...state.exchangeRates,
        asOf: '2026-09-06',
        fetchedAt: futureTimestamp,
      },
    };
    const fxTransaction = state.transactions.find((transaction) => transaction.fxSnapshot);
    if (fxTransaction?.fxSnapshot === undefined) throw new Error('Fixture has no FX transaction');
    const futureFx = {
      ...state,
      transactions: state.transactions.map((transaction) =>
        transaction.id === fxTransaction.id
          ? {
              ...transaction,
              fxSnapshot: {
                ...transaction.fxSnapshot,
                asOf: '2026-09-06',
                fetchedAt: futureTimestamp,
              },
            }
          : transaction,
      ),
    };
    const futureContact = {
      ...state,
      contacts: state.contacts.map((contact, index) =>
        index === 0 ? { ...contact, lastTransferAt: futureTimestamp } : contact,
      ),
    };

    expect(parseBankState(savingsAnchor, NOW)).toBeNull();
    expect(parseBankState(futureRates, NOW)).toBeNull();
    expect(parseBankState(futureFx, NOW)).toBeNull();
    expect(parseBankState(futureContact, NOW)).toBeNull();
  });

  it('projects unknown nested fields out of the canonical bank state', () => {
    const created = createRecurringRule(buildSeed(NOW), {
      ruleId: 'rr_projection_boundary',
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '1',
      locale: 'en',
      counterparty: 'Projection boundary',
      startYear: 2026,
      startMonth: 9,
      anchorDay: 5,
      nowISO: NOW,
    });
    if (!created.ok) throw new Error(created.error);
    const imported = mutable(created.state);
    imported.injected = 'top';
    (imported.exchangeRates as Record<string, unknown>).injected = 'rates';
    (imported.accounts as Record<string, unknown>[])[0].injected = 'account';
    (imported.transactions as Record<string, unknown>[])[0].injected = 'transaction';
    (imported.cards as Record<string, unknown>[])[0].injected = 'card';
    (imported.contacts as Record<string, unknown>[])[0].injected = 'contact';
    (imported.profile as Record<string, unknown>).injected = 'profile';
    (imported.recurringRules as Record<string, unknown>[])[0].injected = 'recurring';
    const importedFxTransaction = (imported.transactions as Record<string, unknown>[])
      .find((transaction) => transaction.fxSnapshot !== undefined);
    if (importedFxTransaction?.fxSnapshot === undefined) {
      throw new Error('Fixture has no FX transaction');
    }
    (importedFxTransaction.fxSnapshot as Record<string, unknown>).injected = 'fx';

    expect(parseBankState(imported, NOW)).toEqual(created.state);
  });

  it('rejects a state with no active account', () => {
    let state = buildSeed(NOW);
    for (const account of state.accounts) {
      const adjusted = applyBalanceAdjustment(state, {
        accountId: account.id,
        targetAmountInput: '0',
        locale: 'en',
        nowISO: NOW,
      });
      if (!adjusted.ok) throw new Error(adjusted.error);
      state = adjusted.state;
    }
    for (const account of state.accounts.slice(0, -1)) {
      const closed = applyCloseAccount(state, account.id, NOW);
      if (!closed.ok) throw new Error(closed.error);
      state = closed.state;
    }
    const lastAccountId = state.accounts.at(-1)?.id;
    if (lastAccountId === undefined) throw new Error('fixture has no accounts');
    const allClosed = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.id === lastAccountId
          ? { ...account, status: 'closed' as const, closedAt: NOW }
          : account,
      ),
      cards: state.cards.map((card) =>
        card.accountId === lastAccountId
          ? { ...card, status: 'frozen' as const, freezeReason: 'account_closed' as const }
          : card,
      ),
    };

    expect(parseBankState(allClosed, NOW)).toBeNull();
  });

  it('rejects a ledger whose running balance goes negative even when its final balance recovers', () => {
    const state = buildSeed(NOW);
    const accountId = state.accounts[0].id;
    const available = balanceOf(state, accountId);
    const dipped = appendRow(state, {
      accountId,
      amountMinor: -(available + 1),
      kind: 'manual_expense',
      counterparty: 'Overdraft probe',
      category: 'other',
      effectiveDate: '2026-09-05',
      createdAt: NOW,
    });
    const recovered = appendRow(dipped, {
      accountId,
      amountMinor: 1,
      kind: 'manual_income',
      counterparty: 'Recovery probe',
      category: 'other',
      effectiveDate: '2026-09-05',
      createdAt: NOW,
    });

    expect(balanceOf(recovered, accountId)).toBe(0);
    expect(parseBankState(recovered, NOW)).toBeNull();
  });

  it('rejects manual income and expense rows attached to a savings account', () => {
    const state = buildSeed(NOW);
    const invalidIncome = appendRow(state, {
      accountId: SAVINGS_ID,
      amountMinor: 100,
      kind: 'manual_income',
      counterparty: 'Manual savings income',
      category: 'other',
      effectiveDate: NOW.slice(0, 10),
      createdAt: NOW,
    });
    const invalidExpense = appendRow(state, {
      accountId: SAVINGS_ID,
      amountMinor: -100,
      kind: 'manual_expense',
      counterparty: 'Manual savings expense',
      category: 'other',
      effectiveDate: NOW.slice(0, 10),
      createdAt: NOW,
    });

    expect(parseBankState(invalidIncome, NOW)).toBeNull();
    expect(parseBankState(invalidExpense, NOW)).toBeNull();
  });

  it('requires every imported manual row to carry an allowed effective date', () => {
    const state = buildSeed(NOW);
    const missingDate = appendRow(state, {
      accountId: CHECKING_ID,
      amountMinor: 100,
      kind: 'manual_income',
      counterparty: 'Missing date',
      category: 'other',
      createdAt: NOW,
    });
    const futureDate = appendRow(state, {
      accountId: CHECKING_ID,
      amountMinor: -100,
      kind: 'manual_expense',
      counterparty: 'Future date',
      category: 'other',
      effectiveDate: '2026-09-06',
      createdAt: NOW,
    });

    expect(parseBankState(missingDate, NOW)).toBeNull();
    expect(parseBankState(futureDate, NOW)).toBeNull();
  });

  it('keeps a valid 120-month backfill parseable as the server clock advances', () => {
    const created = createRecurringRule(buildSeed(NOW, 'USD'), {
      ruleId: 'rr_ten_year_window',
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '1',
      locale: 'en',
      counterparty: 'Long-running retainer',
      startYear: 2016,
      startMonth: 10,
      anchorDay: 5,
      nowISO: NOW,
    });
    if (!created.ok) throw new Error(created.error);

    expect(created.backfilled).toBe(120);
    expect(parseBankState(created.state, '2026-10-06T12:00:00.000Z')).not.toBeNull();
  });

  it('accepts only current-date balance adjustments on savings accounts', () => {
    const current = appendRow(buildSeed(NOW), {
      accountId: SAVINGS_ID,
      amountMinor: 100,
      kind: 'balance_adjustment',
      counterparty: 'Current correction',
      category: 'other',
      effectiveDate: NOW.slice(0, 10),
      createdAt: NOW,
    });
    const backdated = {
      ...current,
      transactions: current.transactions.map((transaction) =>
        transaction.id === current.transactions.at(-1)?.id
          ? { ...transaction, effectiveDate: '2026-09-04' }
          : transaction,
      ),
    };

    expect(parseBankState(current, NOW)).not.toBeNull();
    expect(parseBankState(backdated, NOW)).toBeNull();
  });

  it('derives the savings adjustment date from the createdAt UTC instant', () => {
    const canonicalNow = '2026-09-04T17:30:00.000Z';
    const offsetCreatedAt = '2026-09-05T00:30:00.000+07:00';
    const current = appendRow(buildSeed(canonicalNow), {
      accountId: SAVINGS_ID,
      amountMinor: 100,
      kind: 'balance_adjustment',
      counterparty: 'UTC correction',
      category: 'other',
      effectiveDate: '2026-09-04',
      createdAt: offsetCreatedAt,
    });
    const localCalendarDate = {
      ...current,
      transactions: current.transactions.map((transaction) =>
        transaction.id === current.transactions.at(-1)?.id
          ? { ...transaction, effectiveDate: '2026-09-05' }
          : transaction,
      ),
    };

    expect(parseBankState(current, canonicalNow)).not.toBeNull();
    expect(parseBankState(localCalendarDate, canonicalNow)).toBeNull();
  });

  it('requires exact, continuous monthly occurrences before nextOccurrence', () => {
    const created = createRecurringRule(buildSeed(NOW), {
      ruleId: 'rr_continuous',
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '10.00',
      locale: 'en',
      counterparty: 'Monthly income',
      startYear: 2026,
      startMonth: 7,
      anchorDay: 31,
      nowISO: NOW,
    });
    if (!created.ok) throw new Error(created.error);
    const occurrences = created.state.transactions.filter(
      (transaction) => transaction.recurringRuleId === 'rr_continuous',
    );
    expect(occurrences.map((transaction) => transaction.effectiveDate)).toEqual([
      '2026-07-31',
      '2026-08-31',
    ]);
    expect(parseBankState(created.state, NOW)).not.toBeNull();

    const wrongAnchor = {
      ...created.state,
      transactions: created.state.transactions.map((transaction) =>
        transaction.occurrenceKey === 'rr_continuous:2026-07'
          ? { ...transaction, effectiveDate: '2026-07-30' }
          : transaction,
      ),
    };
    const missingMonth = {
      ...created.state,
      transactions: created.state.transactions.map((transaction): Transaction => {
        if (transaction.occurrenceKey !== 'rr_continuous:2026-07') return transaction;
        const unlinked = { ...transaction };
        delete unlinked.recurringRuleId;
        delete unlinked.occurrenceKey;
        return unlinked;
      }),
    };

    expect(parseBankState(wrongAnchor, NOW)).toBeNull();
    expect(parseBankState(missingMonth, NOW)).toBeNull();
  });

  it('allows a rule with no past occurrence when nextOccurrence still equals startsOn', () => {
    const state = buildSeed(NOW);
    const rule: RecurringRule = {
      id: 'rr_future',
      accountId: CHECKING_ID,
      direction: 'expense',
      amountMinor: 1_000,
      counterparty: 'Future subscription',
      category: 'subscriptions',
      cadence: 'monthly',
      anchorDay: 30,
      startsOn: '2026-09-30',
      nextOccurrence: '2026-09-30',
      status: 'active',
      createdAt: NOW,
    };

    expect(parseBankState({ ...state, recurringRules: [rule] }, NOW)).not.toBeNull();
  });

  it('rejects recurrence starts in a future UTC month or year', () => {
    const state = buildSeed(NOW);
    const futureRule = (id: string, startsOn: string): RecurringRule => ({
      id,
      accountId: CHECKING_ID,
      direction: 'expense',
      amountMinor: 1_000,
      counterparty: 'Future subscription',
      category: 'subscriptions',
      cadence: 'monthly',
      anchorDay: Number(startsOn.slice(8, 10)),
      startsOn,
      nextOccurrence: startsOn,
      status: 'active',
      createdAt: NOW,
    });

    expect(
      parseBankState(
        { ...state, recurringRules: [futureRule('rr_future_month', '2026-10-05')] },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseBankState(
        { ...state, recurringRules: [futureRule('rr_future_year', '2027-09-05')] },
        NOW,
      ),
    ).toBeNull();
  });

  it('rejects an imported initial recurrence backfill beyond 120 occurrences', () => {
    const created = createRecurringRule(buildSeed(NOW, 'USD'), {
      ruleId: 'rr_initial_limit',
      accountId: CHECKING_ID,
      direction: 'income',
      amountInput: '1',
      locale: 'en',
      counterparty: 'Long-running retainer',
      startYear: 2016,
      startMonth: 10,
      anchorDay: 5,
      nowISO: NOW,
    });
    if (!created.ok) throw new Error(created.error);
    const expanded = appendRow(created.state, {
      accountId: CHECKING_ID,
      amountMinor: 100,
      kind: 'manual_income',
      counterparty: 'Long-running retainer',
      category: 'subscriptions',
      effectiveDate: '2016-09-05',
      recurringRuleId: 'rr_initial_limit',
      occurrenceKey: 'rr_initial_limit:2016-09',
      createdAt: NOW,
    });
    const tooLong = {
      ...expanded,
      recurringRules: expanded.recurringRules.map((rule) =>
        rule.id === 'rr_initial_limit' ? { ...rule, startsOn: '2016-09-05' } : rule,
      ),
    };

    expect(created.backfilled).toBe(120);
    expect(parseBankState(created.state, NOW)).not.toBeNull();
    expect(parseBankState(tooLong, NOW)).toBeNull();
  });

  it('rejects post-close transactions and active cards while preserving a manual freeze', () => {
    const zeroed = applyBalanceAdjustment(buildSeed(NOW), {
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
    if (!closed.ok) throw new Error(closed.error);
    expect(parseBankState(closed.state, NOW)).not.toBeNull();

    const postClose = appendRow(closed.state, {
      accountId: CHECKING_ID,
      amountMinor: 0,
      kind: 'seed',
      counterparty: 'Late write',
      category: 'other',
      effectiveDate: NOW.slice(0, 10),
      createdAt: '2026-09-05T12:00:00.001Z',
    });
    const activeCard = {
      ...closed.state,
      cards: closed.state.cards.map((card) =>
        card.accountId === CHECKING_ID
          ? { ...card, status: 'active' as const, freezeReason: undefined }
          : card,
      ),
    };

    expect(parseBankState(postClose, NOW)).toBeNull();
    expect(parseBankState(activeCard, NOW)).toBeNull();
  });

  it('rejects account closure before creation and transactions predating their account', () => {
    const state = buildSeed(NOW);
    const firstCheckingRow = state.transactions.find(
      (transaction) => transaction.accountId === CHECKING_ID,
    );
    if (firstCheckingRow === undefined) throw new Error('fixture has no checking row');
    const rowBeforeAccount = {
      ...state,
      accounts: state.accounts.map((account) =>
        account.id === CHECKING_ID
          ? {
              ...account,
              createdAt: new Date(Date.parse(firstCheckingRow.createdAt) + 1).toISOString(),
            }
          : account,
      ),
    };

    const zeroed = applyBalanceAdjustment(state, {
      accountId: CHECKING_ID,
      targetAmountInput: '0',
      locale: 'en',
      nowISO: NOW,
    });
    if (!zeroed.ok) throw new Error(zeroed.error);
    const closed = applyCloseAccount(zeroed.state, CHECKING_ID, NOW);
    if (!closed.ok) throw new Error(closed.error);
    const closeBeforeCreation = {
      ...closed.state,
      accounts: closed.state.accounts.map((account) =>
        account.id === CHECKING_ID
          ? {
              ...account,
              closedAt: new Date(Date.parse(account.createdAt) - 1).toISOString(),
            }
          : account,
      ),
    };

    expect(parseBankState(state, NOW)).not.toBeNull();
    expect(parseBankState(closed.state, NOW)).not.toBeNull();
    expect(parseBankState(rowBeforeAccount, NOW)).toBeNull();
    expect(parseBankState(closeBeforeCreation, NOW)).toBeNull();
  });

  it('accepts bounded card and contact lists and rejects one item beyond each cap', () => {
    const state = buildSeed(NOW);
    const card = state.cards[0];
    const contact = state.contacts[0];
    if (card === undefined || contact === undefined) throw new Error('fixture lacks card or contact');
    const cardsAtLimit = Array.from({ length: 64 }, (_, index) => ({
      ...card,
      id: `card_limit_${index}`,
    }));
    const contactsAtLimit = Array.from({ length: 256 }, (_, index) => ({
      ...contact,
      id: `contact_limit_${index}`,
    }));
    const atLimit = { ...state, cards: cardsAtLimit, contacts: contactsAtLimit };
    const tooManyCards = {
      ...atLimit,
      cards: [...cardsAtLimit, { ...card, id: 'card_over_limit' }],
    };
    const tooManyContacts = {
      ...atLimit,
      contacts: [...contactsAtLimit, { ...contact, id: 'contact_over_limit' }],
    };

    expect(parseBankState(atLimit, NOW)).not.toBeNull();
    expect(parseBankState(tooManyCards, NOW)).toBeNull();
    expect(parseBankState(tooManyContacts, NOW)).toBeNull();
  });

  it('serializes object keys canonically while retaining array order', () => {
    const state = buildSeed(NOW);
    const reordered = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(canonicalBankStateJson(reordered)).toBe(canonicalBankStateJson(state));
    expect(canonicalBankStateJson({ ...state, accounts: [...state.accounts].reverse() })).not.toBe(
      canonicalBankStateJson(state),
    );
  });
});
