import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppLocale } from '@/i18n';
import { useUiStore } from '@/store/uiStore';
import { UsdEquivalent } from './UsdEquivalent';

function setServerLocale(locale: AppLocale): void {
  useUiStore.getInitialState().locale = locale;
  useUiStore.setState({ locale });
}

describe('UsdEquivalent', () => {
  beforeEach(() => {
    setServerLocale('ru');
  });

  afterEach(() => {
    setServerLocale('ru');
  });

  it('shows the active-account dollar equivalent with the live rate date', () => {
    const markup = renderToStaticMarkup(
      createElement(UsdEquivalent, {
        amountMinor: 393_877,
        sourceCurrency: 'KZT',
        rateSource: 'frankfurter',
        asOf: '2026-09-01',
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('data-rate-status="live"');
    expect(markup).toContain('rounded-full bg-mint');
    expect(markup).toContain('USD');
    expect(markup).toContain('курс 1 сент.');
    expect(markup).toContain('≈');
    expect(markup).toContain('3 938,77 $');
    expect(markup).toContain('text-[1.0625rem] font-semibold');
    expect(markup).toContain('flex-wrap');
  });

  it('labels the offline snapshot honestly', () => {
    const markup = renderToStaticMarkup(
      createElement(UsdEquivalent, {
        amountMinor: 393_877,
        sourceCurrency: 'KZT',
        rateSource: 'fallback',
        asOf: '2026-09-01',
      }),
    );

    expect(markup).toContain('data-rate-status="fallback"');
    expect(markup).toContain('rounded-full border border-ink-3');
    expect(markup).not.toContain('bg-mint');
    expect(markup).toContain('демо-курс');
    expect(markup).not.toContain('курс 01.09');
  });

  it('does not repeat a USD balance as its own equivalent', () => {
    const markup = renderToStaticMarkup(
      createElement(UsdEquivalent, {
        amountMinor: 393_877,
        sourceCurrency: 'USD',
        rateSource: 'frankfurter',
        asOf: '2026-09-01',
      }),
    );

    expect(markup).toBe('');
  });

  it('uses English rate copy, date, separators, and prefix currency symbol', () => {
    setServerLocale('en');

    const markup = renderToStaticMarkup(
      createElement(UsdEquivalent, {
        amountMinor: 393_877,
        sourceCurrency: 'KZT',
        rateSource: 'frankfurter',
        asOf: '2026-09-01',
      }),
    );

    expect(markup).toContain('rate Sep 1');
    expect(markup).toContain('≈');
    expect(markup).toContain('$3,938.77');
    expect(markup).not.toContain('курс');
  });
});
