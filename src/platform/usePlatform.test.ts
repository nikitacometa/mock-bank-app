import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTelegramRetryLoop } from './usePlatform';

afterEach(() => {
  vi.useRealTimers();
});

describe('startTelegramRetryLoop', () => {
  it('restarts the full bounded ladder on each visible transition', () => {
    vi.useFakeTimers();
    const initialize = vi.fn();
    let visibilityListener: VoidFunction | undefined;
    const stop = startTelegramRetryLoop({
      initialize,
      isComplete: () => false,
      getVisibility: () => 'visible',
      subscribeVisibility: (listener) => {
        visibilityListener = listener;
        return vi.fn();
      },
      onAttempt: vi.fn(),
    });

    expect(initialize).toHaveBeenCalledOnce();
    for (let index = 0; index < 4; index += 1) visibilityListener?.();
    expect(initialize).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(250);
    expect(initialize).toHaveBeenCalledTimes(6);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
