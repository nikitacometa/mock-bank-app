import { isTMA } from '@tma.js/sdk-react';

/** Synchronous launch-param probe; safe before the React tree and SDK mount. */
export function isTelegramMiniApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return isTMA();
  } catch {
    return false;
  }
}
