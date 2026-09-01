import { useEffect, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePlatform } from '@/platform/usePlatform';

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

  useEffect(() => {
    if (!open) return;
    return platform.armBack(onClose);
  }, [open, onClose, platform]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-black/55" />
        <Dialog.Content
          className="sheet-panel fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[430px] rounded-t-sheet bg-surface outline-none"
          style={{ paddingBottom: 'max(var(--safe-bottom), 0.75rem)' }}
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" aria-hidden />
          <Dialog.Title className="px-5 pt-4 pb-1 text-[1.0625rem] font-semibold">
            {title}
          </Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
