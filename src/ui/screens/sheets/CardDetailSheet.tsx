import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { currencyName, useI18n } from '@/i18n';
import { groupDigits, localizeDemoText } from '../../format';
import { Sheet } from '../../primitives/Sheet';
import { BankCard } from '../../BankCard';
import { IconCopy, IconFreeze } from '../../icons';

export function CardDetailSheet({ cardId }: { cardId: string }) {
  const card = useBankStore((s) => s.cards.find((c) => c.id === cardId));
  const account = useBankStore((s) => s.accounts.find((a) => a.id === card?.accountId));
  const toggleCardFreeze = useBankStore((s) => s.toggleCardFreeze);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const showToast = useUiStore((s) => s.showToast);
  const platform = usePlatform();
  const { locale, t } = useI18n();

  if (!card || !account) return null;
  const frozen = card.status === 'frozen';

  const copyNumber = async () => {
    if (await platform.copyText(account.number)) {
      platform.haptic('light');
      showToast('cardDetails.copied');
    } else {
      showToast('cardDetails.copyFailed');
    }
  };

  const toggleFreeze = async () => {
    try {
      await toggleCardFreeze(card.id);
      platform.haptic('success');
    } catch (error: unknown) {
      console.error('[card] freeze update failed', error);
      platform.haptic('warning');
      showToast('cardDetails.statusFailed');
    }
  };

  return (
    <Sheet open onClose={closeSheet} title={t('cardDetails.title', { last4: card.last4 })}>
      <div className="px-5 pb-4">
        <div className="mx-auto mt-2 max-w-72">
          <BankCard card={{ ...card, holder: localizeDemoText(card.holder, locale) }} />
        </div>

        <div className="mt-5 divide-y divide-line/50 rounded-card bg-surface-2/50 px-4">
          <button className="flex w-full items-center justify-between py-3.5 text-left" onClick={copyNumber}>
            <span>
              <span className="block text-[0.8125rem] text-ink-3">
                {t('cardDetails.account', { name: localizeDemoText(account.name, locale) })}
              </span>
              <span className="num mt-0.5 block text-[0.9375rem]">{groupDigits(account.number)}</span>
            </span>
            <IconCopy size={19} className="text-ink-3" />
          </button>
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[0.8125rem] text-ink-3">{t('cardDetails.currency')}</span>
            <span className="text-right text-[0.9375rem]">
              {currencyName(locale, account.currency)} · <span className="num">{account.currency}</span>
            </span>
          </div>
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[0.8125rem] text-ink-3">{t('cardDetails.holder')}</span>
            <span className="text-[0.9375rem]">{localizeDemoText(card.holder, locale)}</span>
          </div>
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[0.8125rem] text-ink-3">{t('cardDetails.expires')}</span>
            <span className="num text-[0.9375rem]">{card.expiry}</span>
          </div>
        </div>

        <button
          className={`mt-4 flex w-full items-center justify-center gap-2 rounded-btn py-3.5 text-[0.9375rem] font-medium transition-colors ${
            frozen ? 'bg-mint-dim text-mint' : 'bg-surface-2 text-ink'
          }`}
          onClick={() => void toggleFreeze()}
        >
          <IconFreeze size={18} />
          {frozen ? t('cardDetails.unfreeze') : t('cardDetails.freeze')}
        </button>
      </div>
    </Sheet>
  );
}
