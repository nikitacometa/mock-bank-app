import { describe, expect, it } from 'vitest';
import { applyBankCommand, parseBankCommand } from './bankCommands';
import { buildSeed } from './seed';
import { applyBalanceAdjustment } from './manualTransactions';
import { applyCloseAccount } from './accountLifecycle';

const NOW = '2026-09-05T12:00:00.000Z';

describe('applyBankCommand', () => {
  it('projects exact command keys and rejects an ambiguous transfer target', () => {
    expect(
      parseBankCommand({
        kind: 'record_transaction',
        accountId: 'acc_checking',
        direction: 'expense',
        amountInput: '12.50',
        locale: 'en',
        counterparty: 'Wolt',
        effectiveDate: '2026-09-05',
      }),
    ).toEqual({
      kind: 'record_transaction',
      accountId: 'acc_checking',
      direction: 'expense',
      amountInput: '12.50',
      locale: 'en',
      counterparty: 'Wolt',
      effectiveDate: '2026-09-05',
    });
    expect(
      parseBankCommand({
        kind: 'transfer',
        request: {
          fromAccountId: 'acc_checking',
          toAccountId: 'acc_usd',
          toContactId: 'c_1',
          amountMinor: 100,
          clientTransferId: 'ct_ambiguous',
        },
      }),
    ).toBeNull();
    expect(parseBankCommand({ kind: 'settle', injected: true })).toBeNull();
    expect(parseBankCommand({ kind: 'reset_demo' })).toEqual({ kind: 'reset_demo' });
    expect(parseBankCommand({ kind: 'reset_demo', demoBaseCurrency: 'GEL' })).toBeNull();
    expect(parseBankCommand({ kind: 'rebuild_demo', demoBaseCurrency: 'GEL' })).toBeNull();
  });

  it('changes only reporting currency with set_primary_currency', () => {
    const state = buildSeed(NOW, 'GEL');
    const outcome = applyBankCommand(
      state,
      { kind: 'set_primary_currency', currency: 'USD' },
      { nowISO: NOW },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.primaryCurrency).toBe('USD');
    expect(outcome.state.demoBaseCurrency).toBe('GEL');
    expect(outcome.state.fixtureId).toBe('synthetic-gel-v1');
    expect(outcome.state.accounts).toBe(state.accounts);
    expect(outcome.state.transactions).toBe(state.transactions);
  });

  it('preserves fixture identity when reset_demo rebuilds the ledger', () => {
    const state = {
      ...buildSeed(NOW, 'GEL'),
      primaryCurrency: 'USD' as const,
      profile: { displayName: 'Ada', telegramId: '42' },
    };
    const outcome = applyBankCommand(state, { kind: 'reset_demo' }, { nowISO: NOW });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toMatchObject({
      primaryCurrency: 'USD',
      demoBaseCurrency: 'GEL',
      fixtureId: 'synthetic-gel-v1',
      profile: { displayName: 'Ada', telegramId: '42' },
    });
    expect(outcome.state.recurringRules).toEqual([]);
  });

  it('normalizes a display name in authoritative BankState and rejects controls', () => {
    const state = buildSeed(NOW);
    const updated = applyBankCommand(
      state,
      { kind: 'set_display_name', displayName: '  Ada   Cometa  ' },
      { nowISO: NOW },
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.state.profile.displayName).toBe('Ada Cometa');
    expect(
      applyBankCommand(
        updated.state,
        { kind: 'set_display_name', displayName: 'Ada\nAdmin' },
        { nowISO: NOW },
      ),
    ).toEqual({ ok: false, error: 'invalid_display_name' });
  });

  it('returns transfer receipt metadata instead of requiring a state diff', () => {
    const state = buildSeed(NOW);
    const outcome = applyBankCommand(
      state,
      {
        kind: 'transfer',
        request: {
          fromAccountId: 'acc_checking',
          toAccountId: 'acc_usd',
          amountMinor: 46_227,
          clientTransferId: 'ct_command_receipt',
        },
      },
      { nowISO: NOW },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.incomingAmountMinor).toBe(100);
  });

  it('fails settlement atomically when its interest row would exceed capacity', () => {
    const state = buildSeed('2026-09-02T23:59:59.999Z');
    const outcome = applyBankCommand(state, { kind: 'settle' }, {
      nowISO: NOW,
      limits: { maxTransactions: state.transactions.length },
    });
    expect(outcome).toEqual({ ok: false, error: 'capacity' });
    expect(state.transactions).toHaveLength(436);
  });

  it('reports no changes when an already-active recurring rule is resumed', () => {
    const state = buildSeed(NOW);
    const created = applyBankCommand(
      state,
      {
        kind: 'create_recurring',
        ruleId: 'rr_active_noop',
        accountId: 'acc_checking',
        direction: 'income',
        amountInput: '10',
        locale: 'en',
        counterparty: 'Consulting',
        startYear: 2026,
        startMonth: 9,
        anchorDay: 30,
      },
      { nowISO: NOW },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resumed = applyBankCommand(
      created.state,
      { kind: 'resume_recurring', ruleId: 'rr_active_noop' },
      { nowISO: NOW },
    );

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.applied).toBe(false);
    expect(resumed.state).toBe(created.state);
  });

  it('does not unfreeze a manually frozen card while its linked account is closed', () => {
    const state = buildSeed(NOW);
    const accountId = state.accounts[0].id;
    const card = state.cards.find((candidate) => candidate.accountId === accountId);
    if (card === undefined) throw new Error('fixture card missing');
    const zeroed = applyBalanceAdjustment(state, {
      accountId,
      targetAmountInput: '0',
      locale: 'en',
      nowISO: NOW,
    });
    if (!zeroed.ok) throw new Error(zeroed.error);
    const manuallyFrozen = {
      ...zeroed.state,
      cards: zeroed.state.cards.map((candidate) =>
        candidate.id === card.id
          ? { ...candidate, status: 'frozen' as const, freezeReason: 'manual' as const }
          : candidate,
      ),
    };
    const closed = applyCloseAccount(manuallyFrozen, accountId, NOW);
    if (!closed.ok) throw new Error(closed.error);

    const outcome = applyBankCommand(
      closed.state,
      { kind: 'set_card_frozen', cardId: card.id, frozen: false },
      { nowISO: NOW },
    );

    expect(outcome).toEqual({ ok: false, error: 'account_closed' });
    expect(closed.state.cards.find((candidate) => candidate.id === card.id)).toMatchObject({
      status: 'frozen',
      freezeReason: 'manual',
    });
  });
});
