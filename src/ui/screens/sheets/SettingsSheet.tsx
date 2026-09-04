import { useBankStore, type RatesStatus } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { APP_NAME } from '@/app/config';
import { SUPPORTED_CURRENCIES } from '@/domain/currency';
import type { Currency } from '@/domain/types';
import {
  SUPPORTED_LOCALES,
  currencyName,
  useI18n,
  type AppLocale,
  type TranslationKey,
} from '@/i18n';
import { Sheet } from '../../primitives/Sheet';
import { CometMark } from '../../icons';
import { CurrencyBadge } from '../../CurrencyBadge';
import { fmtRateDate } from '../../format';

const LOCALE_LABEL_KEYS: Readonly<Record<AppLocale, TranslationKey>> = {
  ru: 'settings.language.russian',
  en: 'settings.language.english',
};

export function ratesHealthMessageKey(
  ratesStatus: RatesStatus,
  liveRates: boolean,
): TranslationKey {
  if (ratesStatus === 'loading') return 'settings.rates.loading';
  if (ratesStatus === 'error') {
    return liveRates ? 'settings.rates.liveError' : 'settings.rates.fallbackError';
  }
  return liveRates ? 'settings.rates.live' : 'settings.rates.fallback';
}

export function SettingsSheet() {
  const { locale, setLocale, t } = useI18n();
  const resetDemo = useBankStore((s) => s.resetDemo);
  const primaryCurrency = useBankStore((s) => s.primaryCurrency);
  const setPrimaryCurrency = useBankStore((s) => s.setPrimaryCurrency);
  const exchangeRates = useBankStore((s) => s.exchangeRates);
  const ratesStatus = useBankStore((s) => s.ratesStatus);
  const refreshRates = useBankStore((s) => s.refreshRates);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const showToast = useUiStore((s) => s.showToast);

  const showCurrentToast = (key: TranslationKey, params?: Record<string, string | number>) => {
    showToast(key, params);
  };

  const chooseLocale = (nextLocale: AppLocale) => {
    const saved = setLocale(nextLocale);
    showToast(saved ? 'settings.language.changed' : 'settings.language.saveFailed');
  };

  const chooseCurrency = async (currency: Currency) => {
    try {
      await setPrimaryCurrency(currency);
      showCurrentToast('settings.primary.changed', { currency });
    } catch (error: unknown) {
      console.error('[settings] primary currency update failed', error);
      showCurrentToast('settings.primary.failed');
    }
  };

  const refresh = async () => {
    const result = await refreshRates(true);
    showCurrentToast(
      result === 'failed'
        ? 'settings.rates.failed'
        : result === 'cached'
          ? 'settings.rates.cached'
          : 'settings.rates.updated',
    );
  };

  const rateDate = fmtRateDate(exchangeRates.asOf, locale, 'full');
  const liveRates = exchangeRates.source === 'frankfurter';

  const reset = async () => {
    try {
      await resetDemo();
      closeSheet();
      showCurrentToast('settings.reset.done');
    } catch (error: unknown) {
      console.error('[settings] demo reset failed', error);
      showCurrentToast('settings.reset.failed');
    }
  };

  return (
    <Sheet open onClose={closeSheet} title={t('settings.title')}>
      <div className="px-5 pb-4">
        <div className="mt-2 rounded-card bg-surface-2/50 p-4">
          <div className="flex items-center gap-2 text-[0.9375rem] font-medium">
            <CometMark size={18} className="text-ivory" />
            {APP_NAME} · {t('common.demo')}
          </div>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-2">
            {t('app.disclaimer')}
          </p>
        </div>

        <section className="mt-5">
          <h3 className="kicker px-1">{t('settings.language.title')}</h3>
          <p className="mt-1 px-1 text-[0.8125rem] leading-relaxed text-ink-3">
            {t('settings.language.description')}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {SUPPORTED_LOCALES.map((candidate) => {
              const selected = candidate === locale;
              return (
                <button
                  key={candidate}
                  lang={candidate}
                  className={`min-h-12 rounded-btn border px-3 text-[0.875rem] font-medium transition-colors ${
                    selected
                      ? 'border-ivory/50 bg-ivory/[0.08] text-ink'
                      : 'border-line/50 bg-surface-2/50 text-ink-2 active:bg-surface-2'
                  }`}
                  onClick={() => chooseLocale(candidate)}
                  aria-pressed={selected}
                >
                  {t(LOCALE_LABEL_KEYS[candidate])}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="kicker px-1">{t('settings.primary.title')}</h3>
          <p className="mt-1 px-1 text-[0.8125rem] leading-relaxed text-ink-3">
            {t('settings.primary.description')}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {SUPPORTED_CURRENCIES.map((currency) => {
              const selected = currency === primaryCurrency;
              const name = currencyName(locale, currency);
              return (
                <button
                  key={currency}
                  aria-label={`${currency} ${name}`}
                  className={`flex min-h-16 items-center gap-2.5 rounded-btn border px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? 'border-ivory/50 bg-ivory/[0.08]'
                      : 'border-line/50 bg-surface-2/50 active:bg-surface-2'
                  }`}
                  onClick={() => void chooseCurrency(currency)}
                  aria-pressed={selected}
                >
                  <CurrencyBadge currency={currency} size={38} />
                  <span className="min-w-0">
                    <span className="num block text-[0.8125rem] font-medium">{currency}</span>
                    <span
                      className={`block truncate text-[0.6875rem] ${
                        selected ? 'text-ink-2' : 'text-ink-3'
                      }`}
                    >
                      {name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-5 rounded-card border border-line/60 bg-surface-2/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[0.9375rem] font-medium">{t('settings.rates.title')}</h3>
              <div
                className="mt-1 flex items-center gap-2 text-[0.75rem] text-ink-3"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${
                    ratesStatus === 'error'
                      ? 'bg-coral'
                      : liveRates
                        ? 'bg-mint'
                        : 'bg-ivory'
                  }`}
                />
                {t(ratesHealthMessageKey(ratesStatus, liveRates), { date: rateDate })}
              </div>
            </div>
            <button
              className="min-h-11 rounded-full bg-surface-2 px-3 text-[0.8125rem] font-medium disabled:opacity-45"
              onClick={() => void refresh()}
              disabled={ratesStatus === 'loading'}
            >
              {t('settings.rates.refresh')}
            </button>
          </div>
          <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-3">
            {t('settings.rates.description')}
          </p>
        </section>

        <button
          className="mt-4 w-full rounded-btn bg-surface-2 py-3.5 text-[0.9375rem] font-medium text-coral"
          onClick={() => void reset()}
        >
          {t('settings.reset.action')}
        </button>
        <p className="mt-2 text-center text-[0.75rem] text-ink-3">
          {t('settings.reset.description')}
        </p>
      </div>
    </Sheet>
  );
}
