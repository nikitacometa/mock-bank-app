// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { RatesStatus } from '@/store/bankStore';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { translate, type TranslationKey } from '@/i18n';
import { ratesHealthMessageKey, SettingsSheet } from './SettingsSheet';

vi.mock('../../primitives/Sheet', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    Sheet: ({ children }: { children: ReactNode }) =>
      createMockElement('section', null, children),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsSheet rate health', () => {
  it('maps rate errors to explicit localized health messages for live and fallback snapshots', () => {
    const expectedKeys: Readonly<
      Record<RatesStatus, readonly [fallback: TranslationKey, live: TranslationKey]>
    > = {
      idle: ['settings.rates.fallback', 'settings.rates.live'],
      loading: ['settings.rates.loading', 'settings.rates.loading'],
      fresh: ['settings.rates.fallback', 'settings.rates.live'],
      error: ['settings.rates.fallbackError', 'settings.rates.liveError'],
    };

    for (const [status, [fallbackKey, liveKey]] of Object.entries(expectedKeys) as Array<
      [RatesStatus, readonly [TranslationKey, TranslationKey]]
    >) {
      expect(ratesHealthMessageKey(status, false)).toBe(fallbackKey);
      expect(ratesHealthMessageKey(status, true)).toBe(liveKey);
    }

    const date = '2 сентября 2026 г.';
    expect(
      translate('ru', ratesHealthMessageKey('error', true), { date }),
    ).toBe(`Frankfurter · ${date} · обновить не удалось`);
    expect(
      translate('ru', ratesHealthMessageKey('error', false), { date }),
    ).toBe(`Демо-снимок · ${date} · обновить не удалось`);
    expect(
      translate('en', ratesHealthMessageKey('error', true), { date: 'September 2, 2026' }),
    ).toBe('Frankfurter · September 2, 2026 · refresh failed');
    expect(
      translate('en', ratesHealthMessageKey('error', false), { date: 'September 2, 2026' }),
    ).toBe('Demo snapshot · September 2, 2026 · refresh failed');
  });

  it('keeps one atomic live region through initial error, loading, and terminal error states', async () => {
    const previousBank = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      useUiStore.setState({ ...previousUi, locale: 'en' }, true);
      useBankStore.setState({
        ...previousBank,
        ratesStatus: 'error',
        exchangeRates: {
          ...previousBank.exchangeRates,
          source: 'frankfurter',
          asOf: '2026-09-01',
        },
      }, true);

      await act(async () => {
        root.render(createElement(SettingsSheet));
      });

      expect(container.textContent).toContain(
        'Frankfurter · 09/01/2026 · refresh failed',
      );
      const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
      expect(liveRegion?.getAttribute('aria-atomic')).toBe('true');
      expect(liveRegion?.textContent).toContain(
        'Frankfurter · 09/01/2026 · refresh failed',
      );
      const healthDot = [...container.querySelectorAll<HTMLSpanElement>('span[aria-hidden="true"]')]
        .find((node) => node.classList.contains('size-1.5'));
      expect(healthDot).toBeDefined();
      expect(healthDot?.classList.contains('bg-coral')).toBe(true);

      await act(async () => {
        useBankStore.setState({ ratesStatus: 'loading' });
      });
      const progress = container.querySelector('[role="status"][aria-live="polite"]');
      expect(progress).toBe(liveRegion);
      expect(progress?.getAttribute('aria-atomic')).toBe('true');
      expect(progress?.textContent).toContain('Updating…');

      await act(async () => {
        useBankStore.setState({
          ratesStatus: 'error',
          exchangeRates: {
            ...useBankStore.getState().exchangeRates,
            source: 'fallback',
          },
        });
      });
      const terminalError = container.querySelector('[role="status"][aria-live="polite"]');
      expect(terminalError).toBe(liveRegion);
      expect(terminalError?.getAttribute('aria-atomic')).toBe('true');
      expect(terminalError?.textContent).toContain(
        'Demo snapshot · 09/01/2026 · refresh failed',
      );
      expect(healthDot?.isConnected).toBe(true);
      expect(healthDot?.getAttribute('aria-hidden')).toBe('true');
      expect(healthDot?.classList.contains('bg-coral')).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousBank, true);
      useUiStore.setState(previousUi, true);
    }
  });
});
