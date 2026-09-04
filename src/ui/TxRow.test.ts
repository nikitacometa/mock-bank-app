import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppLocale } from '@/i18n';
import type { Transaction } from '@/domain/types';
import { useUiStore } from '@/store/uiStore';
import { TxRow } from './TxRow';

function setServerLocale(locale: AppLocale): void {
  useUiStore.getInitialState().locale = locale;
  useUiStore.setState({ locale });
}

function renderTransaction(overrides: Partial<Transaction>): string {
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
  return renderToStaticMarkup(createElement(TxRow, { tx, currency: 'KZT' }));
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

  it('renders prototype-shaped category names as an unknown category', () => {
    setServerLocale('en');
    const markup = renderTransaction({ category: 'constructor' });

    expect(markup).toContain('Other');
    expect(markup).toContain('<circle');
  });
});
