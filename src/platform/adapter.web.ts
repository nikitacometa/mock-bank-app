import type { PlatformAdapter } from './types';
import { copyTextToClipboard } from './clipboard';

let nextBackToken = 0;
const ownedBackTokens = new Set<number>();

function isSheetHistoryState(value: unknown): value is { cometaSheet: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cometaSheet' in value &&
    typeof value.cometaSheet === 'number'
  );
}

/** Phase-1 web implementation: no-op where the browser has no equivalent. */
export const webAdapter: PlatformAdapter = {
  isTelegram: false,

  getCurrentUser() {
    return { displayName: 'Никита', source: 'demo' };
  },

  async loadLaunchPreferences() {
    return null;
  },

  haptic(kind) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(kind === 'light' ? 8 : kind === 'success' ? [10, 40, 14] : [18, 60, 18]);
    }
  },

  copyText: copyTextToClipboard,

  mainButton: {
    supported: false,
    show() {},
    hide() {},
  },

  armBack(onBack) {
    // Push a sentinel history entry so the browser/edge-swipe "back"
    // closes the top sheet instead of leaving the app.
    const token = ++nextBackToken;
    let armed = false;
    let disposed = false;
    const onPop = (event: PopStateEvent) => {
      if (!armed) return;

      // A previous sheet can finish its asynchronous history.back() after a
      // replacement sheet has armed. Keep the replacement open and adopt the
      // stale sentinel instead of mistaking that cleanup for a user gesture.
      if (isSheetHistoryState(event.state)) {
        if (event.state.cometaSheet !== token) {
          ownedBackTokens.delete(event.state.cometaSheet);
        }
        history.replaceState({ ...event.state, cometaSheet: token }, '');
        return;
      }

      armed = false;
      ownedBackTokens.delete(token);
      onBack();
    };

    // React StrictMode runs effect setup -> cleanup -> setup in development.
    // Deferring the arm makes the probe setup cancellable, so it never leaves
    // a history entry whose asynchronous cleanup can close the real sheet.
    queueMicrotask(() => {
      if (disposed) return;
      const currentState = history.state;
      const restoredSentinel =
        isSheetHistoryState(currentState) && !ownedBackTokens.has(currentState.cometaSheet);

      ownedBackTokens.add(token);
      if (restoredSentinel) {
        // A reload/session restore can revive our history entry without the
        // sheet that owned it. Reuse that entry so the first back gesture
        // reaches the real page entry instead of another sheet sentinel.
        history.replaceState({ ...currentState, cometaSheet: token }, '');
      } else {
        history.pushState({ cometaSheet: token }, '');
      }
      window.addEventListener('popstate', onPop);
      armed = true;
    });

    return () => {
      disposed = true;
      window.removeEventListener('popstate', onPop);
      if (armed && isSheetHistoryState(history.state) && history.state.cometaSheet === token) {
        armed = false;
        const releaseToken = () => {
          ownedBackTokens.delete(token);
          window.removeEventListener('popstate', releaseToken);
        };
        window.addEventListener('popstate', releaseToken);
        history.back();
      } else if (armed) {
        armed = false;
        ownedBackTokens.delete(token);
      }
    };
  },
};
