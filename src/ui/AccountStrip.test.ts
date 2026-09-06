import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Account } from '@/domain/types';
import type { AppLocale } from '@/i18n';
import { useUiStore } from '@/store/uiStore';
import { AccountStrip } from './AccountStrip';

const ACCOUNTS: readonly Account[] = [
  {
    id: 'acc_active',
    type: 'checking',
    role: 'primary-checking',
    status: 'active',
    name: 'Current',
    currency: 'KZT',
    number: 'CM01KZT000000000001',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'acc_closed',
    type: 'checking',
    role: 'companion-1',
    status: 'closed',
    closedAt: '2026-09-05T00:00:00.000Z',
    name: 'USD',
    currency: 'USD',
    number: 'CM02USD000000000002',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

function setServerLocale(locale: AppLocale): void {
  useUiStore.getInitialState().locale = locale;
  useUiStore.setState({ locale });
}

function renderStrip(): string {
  return renderToStaticMarkup(
    createElement(AccountStrip, {
      accounts: [...ACCOUNTS],
      value: 'acc_closed',
      onChange: () => undefined,
      label: 'Account picker',
    }),
  );
}

describe('AccountStrip accessibility', () => {
  afterEach(() => {
    setServerLocale('ru');
  });

  it('names only the closed account as closed in Russian', () => {
    setServerLocale('ru');

    const markup = renderStrip();

    expect(markup).toContain('aria-label="KZT, Текущий"');
    expect(markup).toContain('aria-label="USD, Доллар США, закрыт"');
    expect(markup).toContain('<span aria-hidden="true">○ </span>USD');
    expect(markup).not.toContain('aria-label="KZT, Текущий, закрыт"');
  });

  it('names only the closed account as closed in English', () => {
    setServerLocale('en');

    const markup = renderStrip();

    expect(markup).toContain('aria-label="KZT, Current"');
    expect(markup).toContain('aria-label="USD, US dollar, closed"');
    expect(markup).not.toContain('aria-label="KZT, Current, closed"');
  });
});
