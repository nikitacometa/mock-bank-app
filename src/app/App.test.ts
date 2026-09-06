import { describe, expect, it } from 'vitest';
import { shouldSettleAfterTelegramForegroundSync } from './App';

describe('shouldSettleAfterTelegramForegroundSync', () => {
  it('settles only after a verified Telegram foreground synchronization', () => {
    expect(shouldSettleAfterTelegramForegroundSync('current')).toBe(true);
    expect(shouldSettleAfterTelegramForegroundSync('applied')).toBe(true);
    expect(shouldSettleAfterTelegramForegroundSync('absent')).toBe(false);
    expect(shouldSettleAfterTelegramForegroundSync('retry')).toBe(false);
  });
});
