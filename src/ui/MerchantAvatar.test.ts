import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MerchantAvatar } from './MerchantAvatar';

function renderMerchant(merchant: string | undefined, category = 'shopping'): string {
  return renderToStaticMarkup(createElement(MerchantAvatar, { merchant, category }));
}

describe('MerchantAvatar', () => {
  it.each([
    ['OPENAI *CHATGPT SUBSCRIPTION', 'chatgpt'],
    ['Spotify AB Stockholm', 'spotify'],
    ['YANDEX.GO', 'yandex-go'],
    ['Yandex Eats', 'yandex-eats'],
    ['Airbnb * HM4P9K', 'airbnb'],
    ['BOOKING.COM 842119', 'booking'],
    ['GOPAY-TOKOPEDIA', 'gopay'],
    ['GOJEK * RIDE', 'gojek'],
    ['APPLE.COM/BILL', 'apple-store'],
    ['AirAsia X', 'airasia'],
    ['SCOOT AIR', 'scoot'],
    ['12GO ASIA', '12go'],
    ['7-ELEVEN #1832', '7-eleven'],
    ['GRAB * TRANSPORT', 'grab'],
    ['LAZADA * ORDER 1832', 'lazada'],
    ['TOKOPEDIA JAKARTA', 'tokopedia'],
    ['UNIQLO EU ONLINE', 'uniqlo'],
    ['TOO QAZAQ-ENERGY 024', 'qazaq-energy'],
  ])('recognizes statement-shaped merchant %s as %s', (merchant, expectedId) => {
    const markup = renderMerchant(merchant);

    expect(markup).toContain(`data-merchant-avatar="${expectedId}"`);
    expect(markup).toContain('<svg');
  });

  it('keeps the category icon fallback for an unknown merchant', () => {
    const markup = renderMerchant('Independent Corner Shop', 'groceries');

    expect(markup).toContain('data-merchant-avatar="fallback"');
    expect(markup).toContain('<circle');
    expect(markup).toContain('<path');
  });

  it('keeps decorative merchant artwork out of the accessibility tree', () => {
    const recognized = renderMerchant('ChatGPT');
    const fallback = renderMerchant(undefined, 'transport');

    expect(recognized).toContain('aria-hidden="true"');
    expect(recognized).toContain('focusable="false"');
    expect(fallback).toContain('aria-hidden="true"');
    expect(fallback).toContain('focusable="false"');
    expect(`${recognized}${fallback}`).not.toContain('role="img"');
  });
});
