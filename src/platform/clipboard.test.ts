import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('copyTextToClipboard', () => {
  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('Cometa')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('Cometa');
  });

  it('keeps the fallback inside the active dialog and restores focus', async () => {
    const dialog = { append: vi.fn() };
    const previousFocus = vi.fn();
    const previousActiveElement = {
      closest: vi.fn(() => dialog),
      focus: previousFocus,
      isConnected: true,
    };
    const textarea = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {
        position: '',
        inset: '',
        width: '',
        height: '',
        padding: '',
        border: '',
        opacity: '',
        pointerEvents: '',
      },
      setAttribute: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    const bodyAppend = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    vi.stubGlobal('document', {
      activeElement: previousActiveElement,
      createElement: vi.fn(() => textarea),
      body: { append: bodyAppend },
      execCommand,
    });

    await expect(copyTextToClipboard('Fallback')).resolves.toBe(true);
    expect(textarea.value).toBe('Fallback');
    expect(textarea.readOnly).toBe(true);
    expect(textarea.tabIndex).toBe(-1);
    expect(dialog.append).toHaveBeenCalledWith(textarea);
    expect(bodyAppend).not.toHaveBeenCalled();
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, 'Fallback'.length);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.focus.mock.invocationCallOrder[0]).toBeLessThan(
      textarea.setSelectionRange.mock.invocationCallOrder[0]!,
    );
    expect(textarea.setSelectionRange.mock.invocationCallOrder[0]).toBeLessThan(
      execCommand.mock.invocationCallOrder[0]!,
    );
  });

  it('uses the document body when focus is outside a dialog', async () => {
    const bodyAppend = vi.fn();
    const previousActiveElement = {
      closest: vi.fn(() => null),
      focus: vi.fn(),
      isConnected: true,
    };
    const textarea = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {},
      setAttribute: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      activeElement: previousActiveElement,
      createElement: vi.fn(() => textarea),
      body: { append: bodyAppend },
      execCommand: vi.fn(() => true),
    });

    await expect(copyTextToClipboard('Body fallback')).resolves.toBe(true);
    expect(bodyAppend).toHaveBeenCalledWith(textarea);
  });

  it('returns false, removes the textarea, and restores focus when copying fails', async () => {
    const previousFocus = vi.fn();
    const previousActiveElement = {
      closest: vi.fn(() => null),
      focus: previousFocus,
      isConnected: true,
    };
    const textarea = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {},
      setAttribute: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      activeElement: previousActiveElement,
      createElement: vi.fn(() => textarea),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => {
        throw new Error('copy denied');
      }),
    });

    await expect(copyTextToClipboard('Denied')).resolves.toBe(false);
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('falls back when a WebView leaves the Clipboard API promise pending', async () => {
    vi.useFakeTimers();
    const textarea = {
      value: '',
      readOnly: false,
      tabIndex: 0,
      style: {},
      setAttribute: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    const previousActiveElement = {
      closest: vi.fn(() => null),
      focus: vi.fn(),
      isConnected: true,
    };
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => new Promise<void>(() => undefined)) },
    });
    vi.stubGlobal('document', {
      activeElement: previousActiveElement,
      createElement: vi.fn(() => textarea),
      body: { append: vi.fn() },
      execCommand: vi.fn(() => true),
    });

    const copied = copyTextToClipboard('Timeout');
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(copied).resolves.toBe(true);
  });
});
