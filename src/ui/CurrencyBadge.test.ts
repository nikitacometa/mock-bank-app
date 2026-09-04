import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencyBadge } from './CurrencyBadge';

describe('CurrencyBadge', () => {
  it('disables native image dragging and uses the semantic border token', () => {
    const markup = renderToStaticMarkup(createElement(CurrencyBadge, { currency: 'KZT' }));

    expect(markup).toContain('draggable="false"');
    expect(markup).toContain('border-ink/10');
    expect(markup).not.toContain('border-white/10');
  });
});
