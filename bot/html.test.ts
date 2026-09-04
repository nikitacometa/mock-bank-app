import { describe, expect, it } from 'vitest';
import { escapeHtml, normalizeDisplayName, telegramDisplayName } from './html.js';

describe('escapeHtml', () => {
  it('escapes every character meaningful to Telegram HTML', () => {
    expect(escapeHtml(`<b title="x">Tom & 'Ada'</b>`))
      .toBe('&lt;b title=&quot;x&quot;&gt;Tom &amp; &#39;Ada&#39;&lt;/b&gt;');
  });
});

describe('normalizeDisplayName', () => {
  it('trims and collapses Unicode separator whitespace', () => {
    expect(normalizeDisplayName('  Ada\u00a0  Lovelace  ')).toBe('Ada Lovelace');
  });

  it('rejects control characters, empty names, and names over 48 code points', () => {
    expect(normalizeDisplayName('Ada\nLovelace')).toBeNull();
    expect(normalizeDisplayName('zero\u200bwidth')).toBeNull();
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(normalizeDisplayName('x'.repeat(49))).toBeNull();
    expect(normalizeDisplayName('🙂'.repeat(48))).toBe('🙂'.repeat(48));
  });

  it('falls back when Telegram profile fields are unsafe', () => {
    expect(telegramDisplayName('<Ada>', undefined, 'Friend')).toBe('<Ada>');
    expect(telegramDisplayName('Ada\n', undefined, 'Friend')).toBe('Friend');
  });
});
