import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastDeliveryTracker, Toast, ToastRegion } from './Toast';

const RESET_NOTICE = 'Демо-данные пересозданы';

interface MockUiState {
  locale: 'ru' | 'en';
  toast: { id: number; key: 'settings.reset.done' } | null;
  sheet: { kind: 'settings' } | null;
  clearToast(): void;
}

const mockedUi = vi.hoisted(() => ({
  state: {
    locale: 'ru',
    toast: null,
    sheet: null,
    clearToast: () => undefined,
  } as MockUiState,
}));

vi.mock('@/store/uiStore', () => ({
  useUiStore: <T>(selector: (state: MockUiState) => T): T => selector(mockedUi.state),
}));

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

beforeEach(() => {
  mockedUi.state.locale = 'ru';
  mockedUi.state.sheet = null;
  mockedUi.state.toast = null;
});

describe('Toast live regions', () => {
  it('releases modal ownership without forgetting the delivered toast id', () => {
    const deliveryTracker = createToastDeliveryTracker();
    deliveryTracker.record(7, 'modal-region');

    deliveryTracker.release('modal-region');

    expect(deliveryTracker.deliveredId).toBe(7);
    expect(deliveryTracker.ownerId).toBeNull();
  });

  it('keeps the outer status region mounted and empty while a sheet is open', () => {
    const deliveryTracker = createToastDeliveryTracker();
    mockedUi.state.sheet = { kind: 'settings' };
    mockedUi.state.toast = { id: 1, key: 'settings.reset.done' };

    const markup = renderToStaticMarkup(createElement(Toast, { deliveryTracker }));

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain(RESET_NOTICE);
    expect(markup).not.toContain('toast-enter');
  });

  it('renders exactly one visual bubble in the active modal region', () => {
    const deliveryTracker = createToastDeliveryTracker();
    mockedUi.state.sheet = { kind: 'settings' };
    mockedUi.state.toast = { id: 1, key: 'settings.reset.done' };

    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(Toast, { deliveryTracker }),
        createElement(ToastRegion, { deliveryTracker }),
      ),
    );

    expect(occurrences(markup, 'role="status"')).toBe(2);
    expect(occurrences(markup, 'toast-enter')).toBe(1);
    expect(occurrences(markup, RESET_NOTICE)).toBe(2);
  });

  it('does not announce or replay animation when the modal-delivered id reaches the outer region', () => {
    const deliveryTracker = createToastDeliveryTracker();
    deliveryTracker.record(1, 'modal-region');
    mockedUi.state.sheet = null;
    mockedUi.state.toast = { id: 1, key: 'settings.reset.done' };

    const markup = renderToStaticMarkup(createElement(Toast, { deliveryTracker }));

    expect(markup).toContain('role="status"');
    expect(occurrences(markup, RESET_NOTICE)).toBe(1);
    expect(occurrences(markup, 'toast-enter')).toBe(0);
    expect(markup).toContain('aria-hidden="true"');
  });

  it('announces and animates a new reset id after the modal closes', () => {
    const deliveryTracker = createToastDeliveryTracker();
    deliveryTracker.record(1, 'modal-region');
    mockedUi.state.sheet = null;
    mockedUi.state.toast = { id: 2, key: 'settings.reset.done' };

    const markup = renderToStaticMarkup(createElement(Toast, { deliveryTracker }));

    expect(markup).toContain('role="status"');
    expect(occurrences(markup, RESET_NOTICE)).toBe(2);
    expect(occurrences(markup, 'toast-enter')).toBe(1);
  });

  it('re-renders a pending keyed notice in the current document language', () => {
    mockedUi.state.locale = 'en';
    mockedUi.state.toast = { id: 1, key: 'settings.reset.done' };

    const markup = renderToStaticMarkup(createElement(Toast));

    expect(markup).toContain('Demo data has been reset');
    expect(markup).not.toContain(RESET_NOTICE);
  });
});
