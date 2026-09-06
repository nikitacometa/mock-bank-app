// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCloseAccount } from '@/domain/accountLifecycle';
import { applyBalanceAdjustment } from '@/domain/manualTransactions';
import { buildSeed } from '@/domain/seed';
import type { Transaction } from '@/domain/types';
import { currencyName } from '@/i18n';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { History } from './History';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('History rendering window', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('bounds the initial DOM and reveals older date groups on demand', async () => {
    const seed = buildSeed('2026-09-02T23:59:59.999Z');
    useBankStore.setState(seed);
    useUiStore.setState({
      activeAccountId: 'acc_checking',
      locale: 'en',
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(History)));

      expect(container.querySelectorAll('section')).toHaveLength(24);
      const showMore = [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show more');
      if (!(showMore instanceof HTMLButtonElement)) throw new Error('Show more button is missing');

      await act(async () => showMore.click());

      expect(container.querySelectorAll('section')).toHaveLength(40);
      expect(document.activeElement).toBe(container.querySelectorAll('h2')[24]);
      const liveRegion = container.querySelector('[role="status"]');
      expect(liveRegion?.textContent).toMatch(/^Showing 40 of \d+ days$/);
      const firstAnnouncement = liveRegion?.textContent;

      let finalPreviousCount = 40;
      let nextButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show more');
      while (nextButton instanceof HTMLButtonElement) {
        const button = nextButton;
        finalPreviousCount = container.querySelectorAll('section').length;
        await act(async () => button.click());
        if (finalPreviousCount === 40) {
          expect(liveRegion?.textContent).not.toBe(firstAnnouncement);
          expect(liveRegion?.textContent).toMatch(/^Showing 56 of \d+ days$/);
        }
        nextButton = [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Show more');
      }

      expect(document.activeElement).toBe(container.querySelectorAll('h2')[finalPreviousCount]);
      expect(liveRegion?.textContent).toMatch(/^Showing \d+ of \d+ days$/);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps a closed account selectable and its preserved history visible', async () => {
    const nowISO = '2026-09-02T23:59:59.999Z';
    const seed = buildSeed(nowISO);
    const companion = seed.accounts.find((account) => account.role === 'companion-1');
    if (companion === undefined) throw new Error('Missing companion account');
    const zeroed = applyBalanceAdjustment(seed, {
      accountId: companion.id,
      targetAmountInput: '0',
      locale: 'en',
      nowISO,
    });
    if (!zeroed.ok) throw new Error(zeroed.error);
    const closed = applyCloseAccount(zeroed.state, companion.id, nowISO);
    if (!closed.ok) throw new Error(closed.error);
    useBankStore.setState(closed.state);
    useUiStore.setState({ activeAccountId: companion.id, locale: 'en' });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(History)));

      const closedAccountButton = container.querySelector<HTMLButtonElement>(
        `[data-account-id="${companion.id}"]`,
      );
      expect(closedAccountButton?.getAttribute('aria-label')).toBe(
        `${companion.currency}, ${currencyName('en', companion.currency)}, closed`,
      );
      expect(
        [...(closedAccountButton?.querySelectorAll('[aria-hidden="true"]') ?? [])].some(
          (element) => element.textContent === '○ ',
        ),
      ).toBe(true);
      expect(container.textContent).toContain('Balance correction');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('searches manual counterparties by their exact user-authored text', async () => {
    const previousBank = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const seed = buildSeed('2026-09-02T23:59:59.999Z');
    const checking = seed.accounts.find((account) => account.id === 'acc_checking');
    if (checking === undefined) throw new Error('Missing checking account');
    const manualTransaction = {
      id: 'tx_manual_name_collision',
      accountId: checking.id,
      seq: 1,
      amountMinor: -1_000,
      balanceAfterMinor: 9_000,
      kind: 'manual_expense' as const,
      counterparty: 'Апа',
      category: 'other',
      effectiveDate: '2026-09-02',
      createdAt: '2026-09-02T12:00:00.000Z',
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      useBankStore.setState({ ...seed, transactions: [manualTransaction] });
      useUiStore.setState({ activeAccountId: checking.id, locale: 'en' });
      await act(async () => root.render(createElement(History)));

      const search = container.querySelector<HTMLInputElement>('input');
      if (search === null) throw new Error('History search is missing');
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setInputValue === undefined) throw new Error('Input value setter is missing');
      expect(container.textContent).toContain('Апа');
      expect(container.textContent).not.toContain('Mum');

      await act(async () => {
        setInputValue.call(search, 'Mum');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.textContent).not.toContain('Апа');

      await act(async () => {
        setInputValue.call(search, 'Апа');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.textContent).toContain('Апа');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousBank, true);
      useUiStore.setState(previousUi, true);
    }
  });

  it.each([
    { timeZone: 'Asia/Bangkok', hour: '23', transferTime: '11:40 PM', manualTime: '11:45 PM' },
    { timeZone: 'America/New_York', hour: '00', transferTime: '12:40 AM', manualTime: '12:45 AM' },
  ])('renders mixed manual and transfer rows under one UTC Today group in $timeZone', async ({
    timeZone, hour, transferTime, manualTime,
  }) => {
    const environment = (
      globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
      }
    ).process?.env;
    if (environment === undefined) throw new Error('test runtime has no process environment');
    const originalTimeZone = environment.TZ;
    const previousBank = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const nowISO = `2026-09-06T${hour}:50:00.000Z`;
    const transaction = (overrides: Partial<Transaction>): Transaction => ({
      id: 'tx_utc_history', accountId: 'acc_checking', seq: 1,
      amountMinor: -1_000, balanceAfterMinor: 9_000,
      kind: 'transfer_contact', counterparty: 'Yesterday transfer', category: 'transfer',
      createdAt: `2026-09-05T${hour}:40:00.000Z`, ...overrides,
    });

    try {
      environment.TZ = timeZone;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(nowISO));
      // This regression must actually run across the local/UTC day boundary.
      expect(new Date(nowISO).getDate()).not.toBe(6);
      const yesterdayTransfer = transaction({ id: 'tx_yesterday_transfer' });
      const todayTransfer = transaction({
        id: 'tx_today_transfer', seq: 2, counterparty: 'Today transfer',
        createdAt: `2026-09-06T${hour}:40:00.000Z`,
      });
      const yesterdayManual = transaction({
        id: 'tx_yesterday_manual', seq: 3, kind: 'manual_expense',
        counterparty: 'Yesterday manual', category: 'other', effectiveDate: '2026-09-05',
        createdAt: `2026-09-06T${hour}:43:00.000Z`,
      });
      const todayManual = transaction({
        id: 'tx_today_manual', seq: 4, kind: 'manual_expense',
        counterparty: 'Today manual', category: 'other', effectiveDate: '2026-09-06',
        createdAt: `2026-09-06T${hour}:45:00.000Z`,
      });
      useBankStore.setState({
        ...buildSeed(nowISO),
        transactions: [todayTransfer, yesterdayManual, yesterdayTransfer, todayManual],
      });
      useUiStore.setState({ activeAccountId: 'acc_checking', locale: 'en' });
      await act(async () => root.render(createElement(History)));

      expect([...container.querySelectorAll('h2')].map((heading) => heading.textContent))
        .toEqual(['Today', 'Yesterday']);
      const groups = [...container.querySelectorAll('section')];
      expect(groups).toHaveLength(2);
      const rows = groups.map((group) =>
        [...group.querySelectorAll('.min-h-15')].map((row) => row.textContent));
      expect(rows).toEqual([
        [expect.stringContaining('Today manual'), expect.stringContaining('Today transfer')],
        [expect.stringContaining('Yesterday manual'), expect.stringContaining('Yesterday transfer')],
      ]);
      expect(rows[0][0]).toContain(`Other · ${manualTime}`);
      expect(rows[0][1]).toContain(`Transfer · ${transferTime}`);
      expect(rows[1][1]).toContain(`Transfer · ${transferTime}`);
      expect(rows[1][0]).not.toMatch(/\d{1,2}:\d{2}/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      if (originalTimeZone === undefined) delete environment.TZ;
      else environment.TZ = originalTimeZone;
      useBankStore.setState(previousBank, true);
      useUiStore.setState(previousUi, true);
    }
  });
});
