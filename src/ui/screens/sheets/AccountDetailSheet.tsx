import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { BANK_BIC, BANK_CORR } from '@/app/config';
import { currencyName, translate, useI18n, type AppLocale } from '@/i18n';
import { groupDigits, localizeDemoText } from '../../format';
import { Sheet } from '../../primitives/Sheet';
import { IconCopy } from '../../icons';

export function profileDisplayName(
  profile: { readonly displayName: string; readonly telegramId?: string },
  locale: AppLocale,
): string {
  return profile.telegramId === undefined
    ? localizeDemoText(profile.displayName, locale)
    : profile.displayName;
}

export function AccountDetailSheet({ accountId }: { accountId: string }) {
  const account = useBankStore((s) => s.accounts.find((a) => a.id === accountId));
  const profile = useBankStore((s) => s.profile);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const showToast = useUiStore((s) => s.showToast);
  const platform = usePlatform();
  const { locale, t } = useI18n();

  if (!account) return null;

  const buildRows = (rowLocale: AppLocale): Array<[string, string]> => [
    [translate(rowLocale, 'accountDetails.recipient'), profileDisplayName(profile, rowLocale)],
    [
      translate(rowLocale, 'accountDetails.currency'),
      `${currencyName(rowLocale, account.currency)} · ${account.currency}`,
    ],
    [translate(rowLocale, 'accountDetails.number'), groupDigits(account.number)],
    [translate(rowLocale, 'accountDetails.bank'), translate(rowLocale, 'accountDetails.bankLegal')],
    [translate(rowLocale, 'accountDetails.bic'), BANK_BIC],
    [translate(rowLocale, 'accountDetails.correspondent'), groupDigits(BANK_CORR)],
  ];
  const rows = buildRows(locale);

  const copyAll = async () => {
    const copyLocale = useUiStore.getState().locale;
    const text = buildRows(copyLocale).map(([key, value]) => `${key}: ${value}`).join('\n');
    if (await platform.copyText(text)) {
      platform.haptic('light');
      showToast('accountDetails.copied');
    } else {
      showToast('accountDetails.copyFailed');
    }
  };

  return (
    <Sheet
      open
      onClose={closeSheet}
      title={t('accountDetails.title', { name: localizeDemoText(account.name, locale) })}
    >
      <div className="px-5 pb-4">
        <div className="mt-2 divide-y divide-line/50 rounded-card bg-surface-2/50 px-4">
          {rows.map(([k, v]) => (
            <div key={k} className="py-3.5">
              <div className="text-[0.8125rem] text-ink-3">{k}</div>
              <div className={`mt-0.5 text-[0.9375rem] ${/\d/.test(v) ? 'num' : ''}`}>
                <bdi dir="auto">{v}</bdi>
              </div>
            </div>
          ))}
        </div>
        <button
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-btn bg-surface-2 py-3.5 text-[0.9375rem] font-medium"
          onClick={copyAll}
        >
          <IconCopy size={18} />
          {t('accountDetails.copyAll')}
        </button>
        <p className="mt-3 text-center text-[0.75rem] text-ink-3">
          {t('accountDetails.disclaimer')}
        </p>
      </div>
    </Sheet>
  );
}
