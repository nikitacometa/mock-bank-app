// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSeed } from '@/domain/seed';
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
});
