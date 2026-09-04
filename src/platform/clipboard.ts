type FocusTarget = Element & { focus?: (options?: FocusOptions) => void };

function focusElement(element: Element | null): boolean {
  const focus = (element as FocusTarget | null)?.focus;
  if (typeof focus !== 'function') return false;

  try {
    focus.call(element, { preventScroll: true });
    return true;
  } catch {
    try {
      focus.call(element);
      return true;
    } catch {
      return false;
    }
  }
}

/** Clipboard capability with a legacy fallback for restricted WebViews. Never throws. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Clipboard API timed out')), 1_500);
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
      return true;
    }
  } catch {
    // Continue to the DOM fallback below.
  }

  if (typeof document === 'undefined') return false;

  const previousActiveElement = document.activeElement;
  let textarea: HTMLTextAreaElement | undefined;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.inset = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.padding = '0';
    textarea.style.border = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';

    const activeDialog = previousActiveElement?.closest('[role="dialog"]');
    (activeDialog ?? document.body).append(textarea);

    if (!focusElement(textarea)) return false;
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.remove();
    if (previousActiveElement?.isConnected !== false) {
      focusElement(previousActiveElement);
    }
  }
}
