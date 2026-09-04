// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { convertMoney } from '@/domain/currency';
import { balanceOf } from '@/domain/ledger';
import { formatMoney, formatMoneyWhole } from '@/domain/money';
import { buildSeed } from '@/domain/seed';
import { applyTransfer } from '@/domain/transfer';
import { useUiStore } from '@/store/uiStore';
import {
  derivePortfolioDisplay,
  deriveUsdEquivalent,
  HeroFxFrame,
  platformUserDisplayName,
  PortfolioTotal,
  resolveUserDisplayName,
} from './Home';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('Home hero financial coherence', () => {
  it('localizes only demo platform identities and preserves host user names byte-for-byte', () => {
    expect(platformUserDisplayName({ displayName: 'Никита', source: 'demo' }, 'en')).toBe('Nikita');
    expect(platformUserDisplayName({ displayName: 'Никита', source: 'host' }, 'en')).toBe('Никита');
    expect(
      resolveUserDisplayName(
        { displayName: 'Custom Никита', telegramId: '9007199254740993' },
        { displayName: 'Telegram Name', source: 'host' },
        'en',
      ),
    ).toBe('Custom Никита');
  });

  it('derives USD from the displayed paused balance and keeps contact portfolio on its paused instance', () => {
    const state = buildSeed('2026-09-02T00:00:00.000Z');
    const account = state.accounts.find(
      (candidate) => candidate.type === 'checking' && candidate.currency === 'KZT',
    );
    const contact = state.contacts[0];
    if (!account || !contact) throw new Error('Seed fixture is incomplete');
    const displayedBalance = balanceOf(state, account.id);
    const transfer = applyTransfer(state, {
      fromAccountId: account.id,
      toContactId: contact.id,
      amountMinor: 123_45,
      clientTransferId: 'ct_home_paused_financials',
      nowISO: '2026-09-02T00:01:00.000Z',
    });
    if (!transfer.ok) throw new Error(`Transfer fixture failed: ${transfer.error}`);
    const liveBalance = balanceOf(transfer.state, account.id);

    const usdEquivalent = deriveUsdEquivalent({
      displayedBalance,
      activeAccount: account,
      exchangeRates: transfer.state.exchangeRates,
    });
    const beforePortfolio = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: state.exchangeRates,
      paused: true,
    });
    const afterPortfolio = derivePortfolioDisplay({
      accounts: transfer.state.accounts,
      transactions: transfer.state.transactions,
      primaryCurrency: transfer.state.primaryCurrency,
      exchangeRates: transfer.state.exchangeRates,
      paused: true,
    });

    expect(usdEquivalent).toBe(
      convertMoney(displayedBalance, account.currency, 'USD', transfer.state.exchangeRates),
    );
    expect(usdEquivalent).not.toBe(
      convertMoney(liveBalance, account.currency, 'USD', transfer.state.exchangeRates),
    );
    expect(afterPortfolio.motionKey).toBe(beforePortfolio.motionKey);
    expect(afterPortfolio.paused).toBe(true);
    expect(afterPortfolio.amountMinor).not.toBe(beforePortfolio.amountMinor);
  });

  it('changes the portfolio remount identity with primary currency and rate metadata', () => {
    const state = buildSeed('2026-09-02T00:00:00.000Z');
    const before = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: state.exchangeRates,
      paused: true,
    });
    const inUsd = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: 'USD',
      exchangeRates: state.exchangeRates,
      paused: true,
    });
    const refreshedRates = {
      ...state.exchangeRates,
      source: 'frankfurter' as const,
      asOf: '2026-09-02',
      fetchedAt: '2026-09-02T00:05:00.000Z',
      rates: { ...state.exchangeRates.rates, KZT: '500' },
    };
    const afterRefresh = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: refreshedRates,
      paused: true,
    });
    const expectedUsdTotal = state.accounts.reduce(
      (total, item) =>
        total +
        convertMoney(
          balanceOf(state, item.id),
          item.currency,
          'USD',
          state.exchangeRates,
        ),
      0,
    );

    expect(inUsd.currency).toBe('USD');
    expect(inUsd.amountMinor).toBe(expectedUsdTotal);
    expect(inUsd.amountMinor).not.toBe(before.amountMinor);
    expect(inUsd.motionKey).not.toBe(before.motionKey);
    expect(afterRefresh.currency).toBe(before.currency);
    expect(afterRefresh.amountMinor).not.toBe(before.amountMinor);
    expect(afterRefresh.motionKey).not.toBe(before.motionKey);
  });

  it('keeps the complete portfolio frame frozen across rate changes while a sheet is open', async () => {
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const before = {
      amountMinor: 1_000_00,
      currency: 'KZT' as const,
      paused: true,
      motionKey: 'KZT|fallback|before',
    };
    const after = {
      amountMinor: 2_000_00,
      currency: 'USD' as const,
      paused: true,
      motionKey: 'USD|frankfurter|after',
    };
    const beforeText = formatMoneyWhole(before.amountMinor, before.currency, 'en');
    const afterText = formatMoneyWhole(after.amountMinor, after.currency, 'en');

    try {
      useUiStore.setState({ ...previousUi, locale: 'en' }, true);
      await act(async () => root.render(createElement(PortfolioTotal, { display: before })));
      expect(container.textContent).toContain(beforeText);

      await act(async () => root.render(createElement(PortfolioTotal, { display: after })));
      expect(container.textContent).toContain(beforeText);
      expect(container.textContent).not.toContain(afterText);

      await act(async () => root.render(createElement(PortfolioTotal, {
        display: { ...after, paused: false },
      })));
      expect(container.textContent).toContain(afterText);
      expect(container.textContent).not.toContain(beforeText);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useUiStore.setState(previousUi, true);
    }
  });

  it('keeps USD quote metadata and portfolio on one frozen FX frame until the sheet closes', async () => {
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const state = buildSeed('2026-09-02T00:00:00.000Z');
    const account = state.accounts.find(
      (candidate) => candidate.type === 'checking' && candidate.currency === 'KZT',
    );
    if (!account) throw new Error('KZT checking fixture is missing');

    const displayedBalance = balanceOf(state, account.id);
    const refreshedRates = {
      ...state.exchangeRates,
      source: 'frankfurter' as const,
      asOf: '2026-09-02',
      fetchedAt: '2026-09-02T00:05:00.000Z',
      rates: { ...state.exchangeRates.rates, KZT: '400' },
    };
    const beforePortfolio = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: state.exchangeRates,
      paused: true,
    });
    const afterPortfolio = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: refreshedRates,
      paused: true,
    });
    const beforeUsd = formatMoney(
      convertMoney(displayedBalance, account.currency, 'USD', state.exchangeRates),
      'USD',
      'en',
    );
    const afterUsd = formatMoney(
      convertMoney(displayedBalance, account.currency, 'USD', refreshedRates),
      'USD',
      'en',
    );
    const beforePortfolioText = formatMoneyWhole(
      beforePortfolio.amountMinor ?? 0,
      beforePortfolio.currency,
      'en',
    );
    const afterPortfolioText = formatMoneyWhole(
      afterPortfolio.amountMinor ?? 0,
      afterPortfolio.currency,
      'en',
    );

    try {
      expect(afterUsd).not.toBe(beforeUsd);
      expect(afterPortfolioText).not.toBe(beforePortfolioText);
      useUiStore.setState({ ...previousUi, locale: 'en' }, true);
      await act(async () => root.render(createElement(HeroFxFrame, {
        displayedBalance,
        activeAccount: account,
        exchangeRates: state.exchangeRates,
        portfolioDisplay: beforePortfolio,
        paused: true,
      })));
      expect(container.textContent).toContain(beforeUsd);
      expect(container.textContent).toContain('demo rate');
      expect(container.textContent).toContain(beforePortfolioText);

      await act(async () => root.render(createElement(HeroFxFrame, {
        displayedBalance,
        activeAccount: account,
        exchangeRates: refreshedRates,
        portfolioDisplay: afterPortfolio,
        paused: true,
      })));
      expect(container.textContent).toContain(beforeUsd);
      expect(container.textContent).toContain('demo rate');
      expect(container.textContent).toContain(beforePortfolioText);
      expect(container.textContent).not.toContain(afterUsd);
      expect(container.textContent).not.toContain('rate Sep 2');
      expect(container.textContent).not.toContain(afterPortfolioText);

      await act(async () => root.render(createElement(HeroFxFrame, {
        displayedBalance,
        activeAccount: account,
        exchangeRates: refreshedRates,
        portfolioDisplay: { ...afterPortfolio, paused: false },
        paused: false,
      })));
      expect(container.textContent).toContain(afterUsd);
      expect(container.textContent).toContain('rate Sep 2');
      expect(container.textContent).toContain(afterPortfolioText);
      expect(container.textContent).not.toContain(beforeUsd);
      expect(container.textContent).not.toContain(beforePortfolioText);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useUiStore.setState(previousUi, true);
    }
  });
});
