import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { BANK_BIC, BANK_CORR, BANK_LEGAL } from '@/app/config';
import { groupDigits } from '../../format';
import { Sheet } from '../../primitives/Sheet';
import { IconCopy } from '../../icons';

export function AccountDetailSheet({ accountId }: { accountId: string }) {
  const account = useBankStore((s) => s.accounts.find((a) => a.id === accountId));
  const profile = useBankStore((s) => s.profile);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const showToast = useUiStore((s) => s.showToast);
  const platform = usePlatform();

  if (!account) return null;

  const rows: Array<[string, string]> = [
    ['Получатель', profile.displayName],
    ['Номер счёта', groupDigits(account.number)],
    ['Банк', BANK_LEGAL],
    ['БИК', BANK_BIC],
    ['Корр. счёт', groupDigits(BANK_CORR)],
  ];

  const copyAll = async () => {
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      platform.haptic('light');
      showToast('Реквизиты скопированы');
    } catch {
      showToast('Не получилось скопировать');
    }
  };

  return (
    <Sheet open onClose={closeSheet} title={`Реквизиты · ${account.name}`}>
      <div className="px-5 pb-4">
        <div className="mt-2 divide-y divide-line/50 rounded-card bg-surface-2/50 px-4">
          {rows.map(([k, v]) => (
            <div key={k} className="py-3.5">
              <div className="text-[0.8125rem] text-ink-3">{k}</div>
              <div className={`mt-0.5 text-[0.9375rem] ${/\d/.test(v) ? 'num' : ''}`}>{v}</div>
            </div>
          ))}
        </div>
        <button
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-btn bg-surface-2 py-3.5 text-[0.9375rem] font-medium"
          onClick={copyAll}
        >
          <IconCopy size={18} />
          Скопировать всё
        </button>
        <p className="mt-3 text-center text-[0.75rem] text-ink-3">
          Реквизиты демонстрационные — переводы по ним не дойдут
        </p>
      </div>
    </Sheet>
  );
}
