import type { PlatformAdapter } from './types';

/** Phase-1 web implementation: no-op where the browser has no equivalent. */
export const webAdapter: PlatformAdapter = {
  isTelegram: false,

  getCurrentUser() {
    return { displayName: 'Никита' };
  },

  haptic(kind) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(kind === 'light' ? 8 : kind === 'success' ? [10, 40, 14] : [18, 60, 18]);
    }
  },

  mainButton: {
    supported: false,
    show() {},
    hide() {},
  },

  armBack(onBack) {
    // Push a sentinel history entry so the browser/edge-swipe "back"
    // closes the top sheet instead of leaving the app.
    let armed = true;
    history.pushState({ cometaSheet: true }, '');
    const onPop = () => {
      if (!armed) return;
      armed = false;
      onBack();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (armed) {
        armed = false;
        // Consume the sentinel we pushed; guard against an empty stack.
        if (history.state && history.state.cometaSheet) history.back();
      }
    };
  },
};
