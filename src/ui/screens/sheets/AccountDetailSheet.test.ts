import { describe, expect, it } from 'vitest';
import { profileDisplayName } from './AccountDetailSheet';

describe('profileDisplayName', () => {
  it('localizes the demo fixture but never rewrites a Telegram profile name', () => {
    expect(profileDisplayName({ displayName: 'Никита' }, 'en')).toBe('Nikita');
    expect(
      profileDisplayName(
        { displayName: 'Никита', telegramId: '9007199254740993' },
        'en',
      ),
    ).toBe('Никита');
  });
});
