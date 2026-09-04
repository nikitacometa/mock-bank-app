import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSeed } from '@/domain/seed';
import { applyTransfer } from '@/domain/transfer';
import type { AppLocale } from '@/i18n';
import { useUiStore } from '@/store/uiStore';
import { derivePortfolioDisplay } from '../screens/Home';
import { HeroAmount } from './Amount';

interface CountUpHarness {
  readonly pendingFrameCount: number;
  display(): number;
  render(value: number, paused: boolean): number;
  runNextFrame(timestamp: number): void;
}

async function createCountUpHarness(initialValue: number, initiallyPaused = false): Promise<CountUpHarness> {
  let stateCursor = 0;
  const stateValues: unknown[] = [];
  let refCursor = 0;
  const refs: Array<{ current: unknown }> = [];
  let effectDeps: readonly unknown[] | undefined;
  let effectCleanup: (() => void) | undefined;
  let pendingEffect:
    | { readonly run: () => void | (() => void); readonly deps: readonly unknown[] | undefined }
    | undefined;
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();

  vi.resetModules();
  vi.doMock('react', () => ({
    useEffect: (
      effect: () => void | (() => void),
      deps: readonly unknown[] | undefined,
    ): void => {
      const unchanged =
        deps !== undefined &&
        effectDeps !== undefined &&
        deps.length === effectDeps.length &&
        deps.every((dependency, index) => Object.is(dependency, effectDeps?.[index]));
      if (!unchanged) pendingEffect = { run: effect, deps };
    },
    useRef: (initial: unknown): { current: unknown } => {
      const index = refCursor;
      refCursor += 1;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useState: (initial: unknown): readonly [unknown, (next: unknown) => void] => {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in stateValues)) stateValues[index] = initial;
      return [
        stateValues[index],
        (next: unknown) => {
          stateValues[index] =
            typeof next === 'function'
              ? (next as (previous: unknown) => unknown)(stateValues[index])
              : next;
        },
      ];
    },
  }));
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('performance', { now: () => 0 });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });

  const { useCountUp } = await import('./useCountUp');
  // This deterministic harness provides the hook slots normally owned by React.
  const runCountUpHook = useCountUp;

  const flushEffect = (): void => {
    if (pendingEffect === undefined) return;
    const effect = pendingEffect;
    pendingEffect = undefined;
    effectCleanup?.();
    effectCleanup = effect.run() ?? undefined;
    effectDeps = effect.deps;
  };

  const render = (value: number, paused: boolean): number => {
    stateCursor = 0;
    refCursor = 0;
    const rendered = runCountUpHook(value, 1_000, paused);
    flushEffect();
    return rendered;
  };

  render(initialValue, initiallyPaused);

  return {
    get pendingFrameCount() {
      return frames.size;
    },
    display: () => stateValues[0] as number,
    render,
    runNextFrame(timestamp) {
      const frame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (frame === undefined) throw new Error('No animation frame is pending');
      frames.delete(frame[0]);
      frame[1](timestamp);
    },
  };
}

function setServerLocale(locale: AppLocale): void {
  useUiStore.getInitialState().locale = locale;
  useUiStore.setState({ locale });
}

describe('HeroAmount localization', () => {
  beforeEach(() => {
    setServerLocale('ru');
  });

  afterEach(() => {
    setServerLocale('ru');
  });

  it('keeps the Russian symbol suffix and separators', () => {
    const markup = renderToStaticMarkup(
      createElement(HeroAmount, { minor: 123_456, currency: 'KZT' }),
    );

    expect(markup).toContain('1 234');
    expect(markup).toContain(',56');
    expect(markup.indexOf('₸')).toBeGreaterThan(markup.indexOf('1 234'));
  });

  it('renders one prefix currency symbol in English without duplicating it', () => {
    setServerLocale('en');

    const markup = renderToStaticMarkup(
      createElement(HeroAmount, { minor: 123_456, currency: 'USD' }),
    );

    expect(markup).toContain('1,234');
    expect(markup).toContain('.56');
    expect(markup.indexOf('$')).toBeLessThan(markup.indexOf('1,234'));
    expect(markup.match(/\$/g)).toHaveLength(1);
  });
});

describe('HeroAmount count-up pause lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('react');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('snaps an active partial frame to the real target when pausing', async () => {
    const harness = await createCountUpHarness(100);
    harness.render(200, false);
    harness.runNextFrame(100);

    expect(harness.display()).toBeGreaterThan(100);
    expect(harness.display()).toBeLessThan(200);

    expect(harness.render(200, true)).toBe(200);
    expect(harness.pendingFrameCount).toBe(0);
  });

  it('keeps the pre-change frame when a value arrives while already paused', async () => {
    const harness = await createCountUpHarness(100, true);

    expect(harness.render(200, true)).toBe(100);
    expect(harness.pendingFrameCount).toBe(0);
  });

  it('keeps the whole pre-transfer portfolio frame during a paused own-FX mutation', async () => {
    const state = buildSeed('2026-09-02T00:00:00.000Z');
    const fromAccount = state.accounts.find(
      (account) => account.type === 'checking' && account.currency === 'KZT',
    );
    const toAccount = state.accounts.find((account) => account.currency === 'USD');
    if (!fromAccount || !toAccount) throw new Error('Seed FX accounts are missing');

    const before = derivePortfolioDisplay({
      accounts: state.accounts,
      transactions: state.transactions,
      primaryCurrency: state.primaryCurrency,
      exchangeRates: state.exchangeRates,
      paused: true,
    });
    const transfer = applyTransfer(state, {
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amountMinor: 123_45,
      clientTransferId: 'ct_home_own_fx_paused',
      nowISO: '2026-09-02T00:01:00.000Z',
    });
    if (!transfer.ok) throw new Error(`Own-FX fixture failed: ${transfer.error}`);
    const after = derivePortfolioDisplay({
      accounts: transfer.state.accounts,
      transactions: transfer.state.transactions,
      primaryCurrency: transfer.state.primaryCurrency,
      exchangeRates: transfer.state.exchangeRates,
      paused: true,
    });
    if (before.amountMinor === null || after.amountMinor === null) {
      throw new Error('Portfolio fixture could not be converted');
    }

    expect(after.amountMinor).not.toBe(before.amountMinor);
    expect(after.motionKey).toBe(before.motionKey);
    const harness = await createCountUpHarness(before.amountMinor, before.paused);
    expect(harness.render(after.amountMinor, after.paused)).toBe(before.amountMinor);
    expect(harness.pendingFrameCount).toBe(0);
  });
});
