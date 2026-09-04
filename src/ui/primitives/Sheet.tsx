import { useEffect, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePlatform } from '@/platform/usePlatform';
import { useI18n } from '@/i18n';
import { IconClose } from '../icons';
import { ToastRegion } from './Toast';

/**
 * Bottom sheet: Radix Dialog for the behaviour (focus trap, scroll lock,
 * portal, ESC) with our own visual skin — never the stock look. Arms the
 * platform back gesture while open (web: popstate; TMA: BackButton).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    return platform.armBack(onClose);
  }, [open, onClose, platform]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-bg/75 backdrop-blur-[2px]" />
        <Dialog.Content
          className="sheet-panel fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[430px] overflow-y-auto overscroll-contain rounded-t-sheet border border-b-0 border-line/60 bg-surface outline-none"
          style={{
            maxHeight: 'calc(var(--app-height) - var(--safe-top) - 0.5rem)',
            paddingBottom: 'max(var(--safe-bottom), 0.75rem)',
          }}
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" aria-hidden />
          <Dialog.Title className="px-5 pt-4 pr-16 pb-1 text-[1.0625rem] font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Close asChild>
            <button
              aria-label={t('common.close')}
              className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:bg-line"
            >
              <IconClose size={19} />
            </button>
          </Dialog.Close>
          <ToastRegion />
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
