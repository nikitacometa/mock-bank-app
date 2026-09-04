import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_LOCALES,
  TRANSLATIONS,
  currencyName,
  isAppLocale,
  translate,
} from './catalog';

describe('i18n catalog', () => {
  it('keeps both locale catalogs complete and non-empty', () => {
    const russianKeys = Object.keys(TRANSLATIONS.ru);

    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(TRANSLATIONS[locale])).toEqual(russianKeys);
      expect(Object.values(TRANSLATIONS[locale]).every((message) => message.trim() !== '')).toBe(
        true,
      );
    }
  });

  it('translates typed keys and interpolates supplied parameters', () => {
    expect(translate('ru', 'settings.primary.changed', { currency: 'KZT' })).toBe(
      'KZT теперь основная валюта',
    );
    expect(translate('en', 'settings.primary.changed', { currency: 'USD' })).toBe(
      'USD is now your primary currency',
    );
    expect(translate('en', 'cards.hint')).toBe(
      'Swipe or drag from the caption · tap a card for details',
    );
  });

  it('returns an unknown runtime key instead of reading from the object prototype', () => {
    expect(translate('en', 'constructor' as never)).toBe('constructor');
  });

  it('localizes currency names without changing their ISO identity', () => {
    expect(currencyName('ru', 'THB')).toBe('Бат');
    expect(currencyName('en', 'THB')).toBe('Thai baht');
  });

  it('accepts only the two supported locale values', () => {
    expect(isAppLocale('ru')).toBe(true);
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('de')).toBe(false);
    expect(isAppLocale(null)).toBe(false);
  });
});
