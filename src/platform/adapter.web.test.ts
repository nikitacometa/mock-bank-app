import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webAdapter } from './adapter.web';

class FakeHistory {
  private entries: unknown[];
  private index: number;
  private readonly pendingBacks: Array<() => void> = [];
  private readonly autoBack: boolean;

  constructor(restoredState?: unknown, autoBack = true) {
    this.entries = restoredState === undefined ? [null] : [null, restoredState];
    this.index = this.entries.length - 1;
    this.autoBack = autoBack;
  }

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(state: unknown): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(state);
    this.index += 1;
  }

  replaceState(state: unknown): void {
    this.entries[this.index] = state;
  }

  back(): void {
    if (this.index === 0) return;
    const navigate = () => {
      this.index -= 1;
      const event = new Event('popstate') as PopStateEvent;
      Object.defineProperty(event, 'state', { value: this.state });
      window.dispatchEvent(event);
    };
    if (this.autoBack) queueMicrotask(navigate);
    else this.pendingBacks.push(navigate);
  }

  flushBack(): void {
    this.pendingBacks.shift()?.();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('webAdapter.armBack', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('history', new FakeHistory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the real sheet open after a StrictMode setup-cleanup-setup probe', async () => {
    const onBack = vi.fn();

    const disposeProbe = webAdapter.armBack(onBack);
    disposeProbe();
    const disposeReal = webAdapter.armBack(onBack);
    await flushMicrotasks();

    expect(onBack).not.toHaveBeenCalled();

    history.back();
    await flushMicrotasks();

    expect(onBack).toHaveBeenCalledOnce();
    disposeReal();
  });

  it('adopts a same-lifetime sentinel left by asynchronous sheet replacement', async () => {
    const fakeHistory = new FakeHistory(undefined, false);
    vi.stubGlobal('history', fakeHistory);
    const firstOnBack = vi.fn();
    const replacementOnBack = vi.fn();

    const disposeFirst = webAdapter.armBack(firstOnBack);
    await flushMicrotasks();
    disposeFirst();

    const disposeReplacement = webAdapter.armBack(replacementOnBack);
    await flushMicrotasks();
    fakeHistory.flushBack();

    expect(firstOnBack).not.toHaveBeenCalled();
    expect(replacementOnBack).not.toHaveBeenCalled();

    history.back();
    fakeHistory.flushBack();

    expect(replacementOnBack).toHaveBeenCalledOnce();
    disposeReplacement();
  });

  it('consumes its sentinel without calling onBack when the sheet closes in UI', async () => {
    const onBack = vi.fn();
    const dispose = webAdapter.armBack(onBack);
    await flushMicrotasks();

    dispose();
    await flushMicrotasks();

    expect(onBack).not.toHaveBeenCalled();
    expect(history.state).toBeNull();
  });

  it('closes with one back after restoring an orphaned sheet sentinel', async () => {
    vi.stubGlobal('history', new FakeHistory({ cometaSheet: 73 }));
    const onBack = vi.fn();
    const dispose = webAdapter.armBack(onBack);
    await flushMicrotasks();

    history.back();
    await flushMicrotasks();

    expect(onBack).toHaveBeenCalledOnce();
    dispose();
  });
});
