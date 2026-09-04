// @vitest-environment happy-dom

import { act, createElement, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { balanceOf } from '@/domain/ledger';
import { formatMoney } from '@/domain/money';
import { buildSeed, CHECKING_ID, SAVINGS_ID } from '@/domain/seed';
import { useBankStore } from '@/store/bankStore';
import { SCHEMA_VERSION } from '@/store/persistence';
import { useUiStore } from '@/store/uiStore';
import { localizeDemoText } from '../../format';
import {
  appendDraftKey,
  formatDraftAmount,
  TransferSheet,
} from './TransferSheet';

vi.mock('../../primitives/Sheet', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    Sheet: ({ children }: { children: ReactNode }) =>
      createMockElement('section', null, children),
  };
});

vi.mock('../../AccountStrip', () => ({ AccountStrip: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('localized transfer draft', () => {
  it('groups an English draft with commas and a decimal point', () => {
    expect(formatDraftAmount('12345.6', 'en')).toBe('12,345.6');
  });

  it('groups a Russian draft with narrow spaces and a decimal comma', () => {
    expect(formatDraftAmount('12345.6', 'ru')).toBe('12\u202F345,6');
  });

  it('keeps a locale-independent canonical decimal internally', () => {
    expect(appendDraftKey('123', '.', 'USD', 'en')).toBe('123.');
    expect(appendDraftKey('123', ',', 'USD', 'ru')).toBe('123.');
  });

  it('enforces each currency display precision', () => {
    expect(appendDraftKey('1.23', '4', 'USD', 'en')).toBe('1.23');
    expect(appendDraftKey('123', '.', 'VND', 'en')).toBe('123');
  });
});

describe('transfer balance preflight', () => {
  it("materializes pending savings interest before the sheet's insufficient-balance gate", async () => {
    const nowISO = '2026-09-04T12:00:00.000Z';
    const pending = buildSeed('2026-09-01T12:00:00.000Z');
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: pending })],
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    const previousStore = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      useBankStore.setState(pending);
      useUiStore.setState({ ...previousUi, activeAccountId: SAVINGS_ID, locale: 'en' }, true);
      const before = useBankStore.getState();
      const availableBefore = balanceOf(before, SAVINGS_ID);
      const amountAtGate = availableBefore + 1;
      const interestRowsBefore = before.transactions.filter(
        (transaction) => transaction.accountId === SAVINGS_ID && transaction.kind === 'interest',
      ).length;

      expect(amountAtGate > availableBefore).toBe(true);
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(TransferSheet, { initialMode: 'contact' }),
          ),
        );
        await flushEffects();
      });

      const after = useBankStore.getState();
      const availableAfter = balanceOf(after, SAVINGS_ID);
      const interestRowsAfter = after.transactions.filter(
        (transaction) => transaction.accountId === SAVINGS_ID && transaction.kind === 'interest',
      ).length;
      expect(interestRowsAfter).toBe(interestRowsBefore + 1);
      expect(availableAfter).toBeGreaterThanOrEqual(amountAtGate);
      expect(amountAtGate > availableAfter).toBe(false);
      expect(container.textContent).toContain(`${formatMoney(availableAfter, 'KZT', 'en')} available`);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousStore, true);
      useUiStore.setState(previousUi, true);
    }
  });

  it('rechecks settlement on the first sheet interaction after a UTC-day rollover', async () => {
    const initialISO = '2026-09-01T12:00:00.000Z';
    const nextDayISO = '2026-09-02T00:01:00.000Z';
    const seeded = buildSeed(initialISO);
    const pending = {
      ...seeded,
      accounts: seeded.accounts.map((account) =>
        account.id === SAVINGS_ID ? { ...account, accrualAnchor: initialISO } : account,
      ),
    };
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: pending })],
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(initialISO);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });

    const previousStore = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      useBankStore.setState(pending);
      useUiStore.setState({ ...previousUi, activeAccountId: SAVINGS_ID, locale: 'en' }, true);
      const rowsBefore = pending.transactions.filter(
        (transaction) => transaction.accountId === SAVINGS_ID && transaction.kind === 'interest',
      ).length;

      await act(async () => {
        root.render(createElement(TransferSheet, { initialMode: 'contact' }));
        await flushEffects();
      });
      const rowsAfterMount = useBankStore.getState().transactions.filter(
        (transaction) => transaction.accountId === SAVINGS_ID && transaction.kind === 'interest',
      ).length;
      expect(rowsAfterMount).toBe(rowsBefore);

      vi.setSystemTime(nextDayISO);
      const one = container.querySelector<HTMLButtonElement>('button[aria-label="1"]');
      if (!one) throw new Error('Transfer keypad did not render');
      await act(async () => {
        one.click();
        await flushEffects();
      });

      expect(useBankStore.getState().transactions.filter(
        (transaction) => transaction.accountId === SAVINGS_ID && transaction.kind === 'interest',
      )).toHaveLength(rowsAfterMount + 1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousStore, true);
      useUiStore.setState(previousUi, true);
    }
  });

  it('mints a new idempotency key when the recipient changes after a post-commit UI failure', async () => {
    const nowISO = '2026-09-02T12:00:00.000Z';
    const pending = buildSeed(nowISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: pending })],
    ]);
    let randomByte = 0;
    let failNextSuccessHaptic = true;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(target: T): T {
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).fill(++randomByte);
        return target;
      },
    });
    vi.stubGlobal('navigator', {
      vibrate(pattern: number | number[]) {
        if (
          failNextSuccessHaptic &&
          Array.isArray(pattern) &&
          pattern[0] === 10
        ) {
          failNextSuccessHaptic = false;
          throw new Error('haptic presentation failed');
        }
        return true;
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const previousStore = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      useBankStore.setState(pending);
      useUiStore.setState({ ...previousUi, activeAccountId: CHECKING_ID, locale: 'en' }, true);
      const transferRowsBefore = pending.transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      ).length;

      await act(async () => {
        root.render(createElement(TransferSheet, { initialMode: 'contact' }));
        await flushEffects();
      });

      const selectContact = async (name: string) => {
        const label = container.querySelector<HTMLElement>(`[title="${name}"]`);
        const button = label?.closest('button');
        if (!button) throw new Error(`Contact ${name} did not render`);
        await act(async () => button.click());
      };
      const submit = async () => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => !candidate.disabled && candidate.textContent?.startsWith('Transfer '));
        if (!button) throw new Error('Enabled transfer action did not render');
        await act(async () => {
          button.click();
          await flushEffects();
        });
      };

      const firstName = localizeDemoText(pending.contacts[0].name, 'en');
      const secondName = localizeDemoText(pending.contacts[1].name, 'en');
      await selectContact(firstName);
      const one = container.querySelector<HTMLButtonElement>('button[aria-label="1"]');
      if (!one) throw new Error('Transfer keypad did not render');
      await act(async () => one.click());
      await submit();

      expect(useBankStore.getState().transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      )).toHaveLength(transferRowsBefore + 1);
      expect(container.textContent).toContain('The transfer did not go through. Try again.');

      await selectContact(secondName);
      await submit();

      expect(useBankStore.getState().transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      )).toHaveLength(transferRowsBefore + 2);
      expect(useBankStore.getState().recentTransferIds.slice(-2)).toEqual([
        `ct_${'01'.repeat(16)}`,
        `ct_${'02'.repeat(16)}`,
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      consoleError.mockRestore();
      useBankStore.setState(previousStore, true);
      useUiStore.setState(previousUi, true);
    }
  });

  it('mints a new idempotency key when the amount changes after a post-commit UI failure', async () => {
    const nowISO = '2026-09-02T12:00:00.000Z';
    const pending = buildSeed(nowISO);
    const storage = new Map<string, string>([
      ['cometa.bank', JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: pending })],
    ]);
    let randomByte = 0;
    let remainingSuccessHapticFailures = 2;
    vi.useFakeTimers();
    vi.setSystemTime(nowISO);
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(target: T): T {
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).fill(++randomByte);
        return target;
      },
    });
    vi.stubGlobal('navigator', {
      vibrate(pattern: number | number[]) {
        if (
          remainingSuccessHapticFailures > 0 &&
          Array.isArray(pattern) &&
          pattern[0] === 10
        ) {
          remainingSuccessHapticFailures -= 1;
          throw new Error('haptic presentation failed');
        }
        return true;
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const previousStore = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      useBankStore.setState(pending);
      useUiStore.setState({ ...previousUi, activeAccountId: CHECKING_ID, locale: 'en' }, true);
      const transferRowsBefore = pending.transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      ).length;

      await act(async () => {
        root.render(createElement(TransferSheet, { initialMode: 'contact' }));
        await flushEffects();
      });

      const firstName = localizeDemoText(pending.contacts[0].name, 'en');
      const contactLabel = container.querySelector<HTMLElement>(`[title="${firstName}"]`);
      const contactButton = contactLabel?.closest('button');
      if (!contactButton) throw new Error(`Contact ${firstName} did not render`);
      await act(async () => contactButton.click());

      const keypad = (label: string) => {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        if (!button) throw new Error(`Keypad key ${label} did not render`);
        return button;
      };
      const submit = async () => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => !candidate.disabled && candidate.textContent?.startsWith('Transfer '));
        if (!button) throw new Error('Enabled transfer action did not render');
        await act(async () => {
          button.click();
          await flushEffects();
        });
      };

      // Batched keypad actions must compose against the latest draft, not a stale render closure.
      await act(async () => {
        keypad('1').click();
        keypad('.').click();
        keypad('2').click();
        keypad('3').click();
      });
      await submit();

      expect(useBankStore.getState().transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      )).toHaveLength(transferRowsBefore + 1);
      expect(container.textContent).toContain('The transfer did not go through. Try again.');

      // A third fractional digit is ignored, so retrying must retain the original key and no-op.
      await act(async () => keypad('4').click());
      await submit();
      expect(useBankStore.getState().transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      )).toHaveLength(transferRowsBefore + 1);

      // A real edit invalidates the committed key even when two keypad actions are batched.
      await act(async () => {
        keypad('Delete digit').click();
        keypad('4').click();
      });
      await submit();

      const addedRows = useBankStore.getState().transactions.filter(
        (transaction) => transaction.kind === 'transfer_contact',
      ).slice(transferRowsBefore);
      expect(addedRows.map((transaction) => transaction.amountMinor)).toEqual([-123, -124]);
      expect(useBankStore.getState().recentTransferIds.slice(-2)).toEqual([
        `ct_${'01'.repeat(16)}`,
        `ct_${'02'.repeat(16)}`,
      ]);
      expect(container.textContent).toContain(
        `${formatMoney(Math.abs(addedRows[1].amountMinor), 'KZT', 'en')} → ${firstName}`,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      consoleError.mockRestore();
      useBankStore.setState(previousStore, true);
      useUiStore.setState(previousUi, true);
    }
  });
});
