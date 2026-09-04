// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { MainButtonConfig } from '@/platform/types';
import { PrimaryAction } from './PrimaryAction';

const mockedMainButton = vi.hoisted(() => ({
  show: vi.fn<(config: MainButtonConfig) => void>(),
  hide: vi.fn<() => void>(),
}));

vi.mock('@/platform/usePlatform', () => ({
  usePlatform: () => ({
    mainButton: {
      supported: true,
      show: mockedMainButton.show,
      hide: mockedMainButton.hide,
    },
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('PrimaryAction native callback', () => {
  it('keeps one forwarding callback across config updates and calls the latest handler', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();

    try {
      await act(async () => {
        root.render(createElement(PrimaryAction, {
          text: 'Continue',
          onClick: firstHandler,
        }));
      });
      const firstConfig = mockedMainButton.show.mock.calls.at(-1)?.[0];
      if (!firstConfig) throw new Error('Native MainButton was not shown');

      await act(async () => {
        root.render(createElement(PrimaryAction, {
          text: 'Confirm',
          onClick: latestHandler,
          disabled: true,
        }));
      });
      const latestConfig = mockedMainButton.show.mock.calls.at(-1)?.[0];
      if (!latestConfig) throw new Error('Native MainButton was not updated');

      expect(latestConfig.onClick).toBe(firstConfig.onClick);
      latestConfig.onClick();
      expect(latestHandler).toHaveBeenCalledOnce();
      expect(firstHandler).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      mockedMainButton.show.mockReset();
      mockedMainButton.hide.mockReset();
    }
  });
});
