// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertMoney } from '@/domain/currency';
import { formatMoney } from '@/domain/money';
import { buildSeed } from '@/domain/seed';
import { useUiStore } from '@/store/uiStore';
import { derivePortfolioDisplay, HeroFxFrame } from '../screens/Home';
import { HeroAmount } from './Amount';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCountUp financial frame coherence', () => {
  it('gives the pause-entry target to HeroFxFrame before its paused frame freezes', async () => {
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    });

    const state = buildSeed('2026-09-02T00:00:00.000Z');
    const account = state.accounts.find(
      (candidate) => candidate.type === 'checking' && candidate.currency === 'KZT',
    );
    if (!account) throw new Error('KZT checking fixture is missing');

    const initialBalance = 100_000;
    const targetBalance = 200_000;
    const portfolio = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: state.exchangeRates,
      paused: false,
    });
    const targetUsd = formatMoney(
      convertMoney(targetBalance, account.currency, 'USD', state.exchangeRates),
      'USD',
      'en',
    );

    const renderFrame = (balance: number, paused: boolean) =>
      createElement(HeroAmount, {
        minor: balance,
        currency: account.currency,
        paused,
        children: (displayedBalance: number) =>
          createElement(
            'div',
            { 'data-testid': 'financial-frame', 'data-displayed-balance': displayedBalance },
            createElement(HeroFxFrame, {
              displayedBalance,
              activeAccount: account,
              exchangeRates: state.exchangeRates,
              portfolioDisplay: { ...portfolio, paused },
              paused,
            }),
          ),
      });

    try {
      useUiStore.setState({ ...previousUi, locale: 'en' }, true);
      await act(async () => root.render(renderFrame(initialBalance, false)));
      await act(async () => root.render(renderFrame(targetBalance, false)));

      const frame = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!frame) throw new Error('Count-up frame was not scheduled');
      frames.delete(frame[0]);
      await act(async () => frame[1](performance.now() + 80));

      const financialFrame = container.querySelector('[data-testid="financial-frame"]');
      const partialBalance = Number(financialFrame?.getAttribute('data-displayed-balance'));
      expect(partialBalance).toBeGreaterThan(initialBalance);
      expect(partialBalance).toBeLessThan(targetBalance);
      const partialUsd = formatMoney(
        convertMoney(partialBalance, account.currency, 'USD', state.exchangeRates),
        'USD',
        'en',
      );
      expect(partialUsd).not.toBe(targetUsd);
      expect(container.textContent).toContain(partialUsd);

      await act(async () => root.render(renderFrame(targetBalance, true)));

      expect(financialFrame?.getAttribute('data-displayed-balance')).toBe(String(targetBalance));
      expect(container.textContent).toContain(targetUsd);
      expect(container.textContent).not.toContain(partialUsd);
      expect(frames.size).toBe(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useUiStore.setState(previousUi, true);
    }
  });
});
