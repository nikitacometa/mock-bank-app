import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { groupDigits } from '../../format';
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

  if (!card || !account) return null;
  const frozen = card.status === 'frozen';

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(account.number);
      platform.haptic('light');
      showToast('Номер счёта скопирован');
    } catch {
      showToast('Не получилось скопировать');
    }
  };

  return (
    <Sheet open onClose={closeSheet} title={`Карта ·· ${card.last4}`}>
      <div className="px-5 pb-4">
        <div className="mx-auto mt-2 max-w-72">
          <BankCard card={card} />
        </div>

        <div className="mt-5 divide-y divide-line/50 rounded-card bg-surface-2/50 px-4">
          <button className="flex w-full items-center justify-between py-3.5 text-left" onClick={copyNumber}>
            <span>
              <span className="block text-[0.8125rem] text-ink-3">Счёт «{account.name}»</span>
              <span className="num mt-0.5 block text-[0.9375rem]">{groupDigits(account.number)}</span>
            </span>
            <IconCopy size={19} className="text-ink-3" />
          </button>
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[0.8125rem] text-ink-3">Держатель</span>
            <span className="text-[0.9375rem]">{card.holder}</span>
          </div>
          <div className="flex items-center justify-between py-3.5">
            <span className="text-[0.8125rem] text-ink-3">Действует до</span>
            <span className="num text-[0.9375rem]">{card.expiry}</span>
          </div>
        </div>

        <button
          className={`mt-4 flex w-full items-center justify-center gap-2 rounded-btn py-3.5 text-[0.9375rem] font-medium transition-colors ${
            frozen ? 'bg-mint-dim text-mint' : 'bg-surface-2 text-ink'
          }`}
          onClick={() => {
            toggleCardFreeze(card.id);
            platform.haptic('success');
          }}
        >
          <IconFreeze size={18} />
          {frozen ? 'Разморозить карту' : 'Заморозить карту'}
        </button>
      </div>
    </Sheet>
  );
}
