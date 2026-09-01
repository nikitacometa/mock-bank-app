import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { APP_NAME, DISCLAIMER } from '@/app/config';
import { Sheet } from '../../primitives/Sheet';
import { CometMark } from '../../icons';

export function SettingsSheet() {
  const resetDemo = useBankStore((s) => s.resetDemo);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const showToast = useUiStore((s) => s.showToast);

  return (
    <Sheet open onClose={closeSheet} title="Настройки">
      <div className="px-5 pb-4">
        <div className="mt-2 rounded-card bg-surface-2/50 p-4">
          <div className="flex items-center gap-2 text-[0.9375rem] font-medium">
            <CometMark size={18} className="text-ivory" />
            {APP_NAME} · демо
          </div>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-2">{DISCLAIMER}</p>
        </div>

        <button
          className="mt-4 w-full rounded-btn bg-surface-2 py-3.5 text-[0.9375rem] font-medium text-coral"
          onClick={() => {
            resetDemo();
            closeSheet();
            showToast('Демо-данные пересозданы');
          }}
        >
          Сбросить демо-данные
        </button>
        <p className="mt-2 text-center text-[0.75rem] text-ink-3">
          История, счета и карты вернутся к началу
        </p>
      </div>
    </Sheet>
  );
}
