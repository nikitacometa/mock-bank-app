// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { Cards } from './Cards';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function dispatchMousePointer(
  target: Element,
  type: string,
  init: PointerEventInit,
): void {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'mouse',
    isPrimary: true,
    ...init,
  }));
}

describe('Cards mouse drag', () => {
  it('keeps the rendered drag surface non-selectable and clears stale capture state', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(Cards)));
      const track = container.querySelector<HTMLElement>('[data-card]')?.parentElement;
      if (!(track instanceof HTMLDivElement)) throw new Error('Card track is missing');
      expect(track.classList.contains('select-none')).toBe(true);

      const capturedPointers = new Set<number>();
      Object.defineProperties(track, {
        setPointerCapture: {
          configurable: true,
          value: (pointerId: number) => capturedPointers.add(pointerId),
        },
        hasPointerCapture: {
          configurable: true,
          value: (pointerId: number) => capturedPointers.has(pointerId),
        },
        releasePointerCapture: {
          configurable: true,
          value: (pointerId: number) => capturedPointers.delete(pointerId),
        },
      });

      await act(async () => {
        dispatchMousePointer(track, 'pointerdown', {
          pointerId: 7,
          button: 0,
          buttons: 1,
          clientX: 100,
        });
        dispatchMousePointer(track, 'pointermove', {
          pointerId: 7,
          buttons: 1,
          clientX: 70,
        });
      });
      expect(track.scrollLeft).toBe(30);

      capturedPointers.delete(7);
      await act(async () => {
        dispatchMousePointer(track, 'lostpointercapture', {
          pointerId: 7,
          buttons: 0,
          clientX: 70,
        });
        dispatchMousePointer(track, 'pointermove', {
          pointerId: 7,
          buttons: 1,
          clientX: 10,
        });
      });
      expect(track.scrollLeft).toBe(30);

      await act(async () => {
        dispatchMousePointer(track, 'pointerdown', {
          pointerId: 8,
          button: 0,
          buttons: 1,
          clientX: 100,
        });
        dispatchMousePointer(track, 'pointermove', {
          pointerId: 8,
          buttons: 0,
          clientX: 10,
        });
      });
      expect(capturedPointers.has(8)).toBe(false);
      expect(track.scrollLeft).toBe(30);

      await act(async () => {
        dispatchMousePointer(track, 'pointermove', {
          pointerId: 8,
          buttons: 1,
          clientX: 0,
        });
      });
      expect(track.scrollLeft).toBe(30);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('shows a useful empty state when no active account owns a card', async () => {
    const previousBank = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      useUiStore.setState({ ...previousUi, locale: 'en' }, true);
      useBankStore.setState({
        ...previousBank,
        accounts: previousBank.accounts.map((account) => ({
          ...account,
          status: 'closed' as const,
          closedAt: '2026-09-05T00:00:00.000Z',
        })),
      }, true);
      await act(async () => root.render(createElement(Cards)));

      expect(container.textContent).toContain('No active cards');
      expect(container.textContent).toContain('Restore an account in the Telegram bot.');
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector('[data-card]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousBank, true);
      useUiStore.setState(previousUi, true);
    }
  });

  it('keeps a custom account label exact when it matches fixture copy', async () => {
    const previousBank = useBankStore.getState();
    const previousUi = useUiStore.getState();
    const card = previousBank.cards[0];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      useUiStore.setState({ ...previousUi, locale: 'ru' }, true);
      useBankStore.setState({
        ...previousBank,
        accounts: previousBank.accounts.map((account) =>
          account.id === card.accountId
            ? { ...account, role: 'custom' as const, name: 'Current' }
            : account,
        ),
      }, true);
      await act(async () => root.render(createElement(Cards)));

      const firstCard = container.querySelector<HTMLElement>('[data-card]');
      expect(firstCard?.textContent).toContain('Current');
      expect(firstCard?.textContent).not.toContain('Текущий');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useBankStore.setState(previousBank, true);
      useUiStore.setState(previousUi, true);
    }
  });
});
