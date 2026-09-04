import { useCallback, useMemo } from 'react';
import { useUiStore } from '@/store/uiStore';
import {
  translate,
  type AppLocale,
  type TranslationKey,
  type TranslationParams,
} from './catalog';

export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

export interface I18nApi {
  readonly locale: AppLocale;
  readonly t: Translate;
  readonly setLocale: (locale: AppLocale) => boolean;
}

export function useI18n(): I18nApi {
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  const t = useCallback<Translate>(
    (key, params) => translate(locale, key, params),
    [locale],
  );

  return useMemo(() => ({ locale, t, setLocale }), [locale, setLocale, t]);
}
