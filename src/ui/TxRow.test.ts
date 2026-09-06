import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppLocale } from '@/i18n';
import type { Transaction } from '@/domain/types';
import { useUiStore } from '@/store/uiStore';
import { buildOwnTransferCounterpartIndex, type OwnTransferCounterpartIndex } from './format';
import { TxRow } from './TxRow';

function setServerLocale(locale: AppLocale): void {
  useUiStore.getInitialState().locale = locale;
  useUiStore.setState({ locale });
}

function renderTransaction(
  overrides: Partial<Transaction>,
  context: {
    ownTransferCounterparts?: OwnTransferCounterpartIndex;
  } = {},
): string {
  const tx: Transaction = {
    id: 'tx_fixture',
    accountId: 'acc_checking',
    seq: 1,
    amountMinor: -123_456,
    balanceAfterMinor: 900_000,
    kind: 'purchase',
    counterparty: 'Городское такси',
    category: 'transport',
    createdAt: new Date(2026, 8, 1, 19, 34).toISOString(),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(TxRow, { tx, currency: 'KZT', ...context }));
}

describe('TxRow localization', () => {
  afterEach(() => {
    setServerLocale('ru');
  });

  it('localizes known merchant, contact, and account fixture names in English', () => {
    setServerLocale('en');

    const merchant = renderTransaction({});
    const contact = renderTransaction({
      kind: 'transfer_contact',
      counterparty: 'Айдана',
      category: 'transfer',
    });
    const account = renderTransaction({
      kind: 'transfer_own_out',
      counterparty: 'Накопительный',
      category: 'transfer',
    });

    expect(merchant).toContain('City Taxi');
    expect(merchant).toContain('Transport');
    expect(merchant).toMatch(/7:34(?:\u202f|\s)PM/);
    expect(merchant).toContain('−₸1,234.56');
    expect(contact).toContain('Aidana');
    expect(account).toContain('Transfer to Savings');
    expect(account).toContain('Between accounts');
    expect(`${merchant}${contact}${account}`).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('preserves Russian fixture presentation and money formatting', () => {
    setServerLocale('ru');
    const markup = renderTransaction({});

    expect(markup).toContain('Городское такси');
    expect(markup).toContain('Транспорт');
    expect(markup).toContain('−1 234,56 ₸');
  });

  it('surfaces a statement hold as a localized pending badge', () => {
    setServerLocale('ru');
    const russian = renderTransaction({ counterparty: 'ChatGPT', status: 'pending' });
    setServerLocale('en');
    const english = renderTransaction({ counterparty: 'ChatGPT', status: 'pending' });

    expect(russian).toContain('В обработке');
    expect(english).toContain('Pending');
    expect(english).toContain('ChatGPT');
  });

  it('shows a user note and omits the append-time from a backdated row', () => {
    setServerLocale('en');
    const markup = renderTransaction({
      kind: 'manual_expense',
      counterparty: 'Spotify',
      category: 'subscriptions',
      note: 'Family plan',
      effectiveDate: '2026-08-19',
      createdAt: '2026-09-05T23:47:00.000Z',
    });

    expect(markup).toContain('Subscriptions · Family plan');
    expect(markup).not.toContain('11:47 PM');
  });

  it('preserves a user-authored counterparty that matches fixture copy', () => {
    setServerLocale('en');
    const markup = renderTransaction({
      kind: 'manual_expense',
      counterparty: 'Апа',
      category: 'other',
    });

    expect(markup).toContain('Апа');
    expect(markup).not.toContain('Mum');
  });

  it('preserves a custom counterpart account name that matches fixture copy', () => {
    setServerLocale('ru');
    const accounts = [
      {
        id: 'acc_source',
        type: 'checking' as const,
        role: 'primary-checking' as const,
        status: 'active' as const,
        name: 'Current',
        currency: 'KZT' as const,
        number: 'CM01KZT000000000001',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'acc_target',
        type: 'checking' as const,
        role: 'custom' as const,
        status: 'active' as const,
        name: 'Current',
        currency: 'KZT' as const,
        number: 'CM02KZT000000000002',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ];
    const incoming: Transaction = {
      id: 'tx_custom_account_in',
      accountId: accounts[1].id,
      seq: 2,
      amountMinor: 123_456,
      balanceAfterMinor: 1_023_456,
      kind: 'transfer_own_in',
      counterparty: accounts[0].name,
      category: 'transfer',
      transferGroupId: 'grp_custom_account',
      createdAt: new Date(2026, 8, 1, 19, 34).toISOString(),
    };
    const outgoing: Transaction = {
      ...incoming,
      id: 'tx_custom_account_out',
      accountId: accounts[0].id,
      seq: 1,
      amountMinor: -123_456,
      balanceAfterMinor: 900_000,
      kind: 'transfer_own_out',
      counterparty: accounts[1].name,
    };
    const markup = renderTransaction(outgoing, {
      ownTransferCounterparts: buildOwnTransferCounterpartIndex(
        accounts,
        [outgoing, incoming],
      ),
    });

    expect(markup).toContain('Перевод на Current');
    expect(markup).not.toContain('Перевод на Текущий');
  });

  it('renders prototype-shaped category names as an unknown category', () => {
    setServerLocale('en');
    const markup = renderTransaction({ category: 'constructor' });

    expect(markup).toContain('Other');
    expect(markup).toContain('<circle');
  });
});
