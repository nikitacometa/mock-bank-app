import { useEffect, useId } from 'react';
import { translate } from '@/i18n';
import { useUiStore } from '@/store/uiStore';

export interface ToastDeliveryTracker {
  readonly deliveredId: number | null;
  readonly ownerId: string | null;
  record(toastId: number, ownerId: string): void;
  release(ownerId: string): void;
}

export function createToastDeliveryTracker(): ToastDeliveryTracker {
  let deliveredId: number | null = null;
  let ownerId: string | null = null;
  return {
    get deliveredId() {
      return deliveredId;
    },
    get ownerId() {
      return ownerId;
    },
    record(toastId, nextOwnerId) {
      deliveredId = toastId;
      ownerId = nextOwnerId;
    },
    release(currentOwnerId) {
      if (ownerId === currentOwnerId) ownerId = null;
    },
  };
}

const sharedDeliveryTracker = createToastDeliveryTracker();

interface ToastRegionProps {
  active?: boolean;
  deliveryTracker?: ToastDeliveryTracker;
}

/** Stable live region. Sheet renders its own active copy inside the modal boundary. */
export function ToastRegion({
  active = true,
  deliveryTracker = sharedDeliveryTracker,
}: ToastRegionProps) {
  const toast = useUiStore((s) => s.toast);
  const locale = useUiStore((s) => s.locale);
  const regionId = useId();
  const message = toast === null ? null : translate(locale, toast.key, toast.params);
  const handedOff =
    active &&
    toast !== null &&
    deliveryTracker.deliveredId === toast.id &&
    deliveryTracker.ownerId !== regionId;

  useEffect(() => {
    // Claim an ID only after this active region commits. A toast minted in the
    // same batch that closes a sheet therefore remains new to the outer region.
    if (!active || toast === null) {
      // The persistent outer region must not reclaim its old ID after a modal
      // boundary handoff; returning with that ID is a silent visual continuation.
      deliveryTracker.release(regionId);
      return;
    }
    if (deliveryTracker.deliveredId !== toast.id) {
      deliveryTracker.record(toast.id, regionId);
    }
    return () => deliveryTracker.release(regionId);
  }, [active, toast, deliveryTracker, regionId]);

  return (
    <div
      className="pointer-events-none fixed inset-x-4 z-[60] mx-auto max-w-[398px]"
      style={{ bottom: 'calc(var(--safe-bottom) + 5.5rem)' }}
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {active && toast && !handedOff && <span key={`live-${toast.id}`}>{message}</span>}
      </span>
      {active && toast && (
        <div
          key={toast.id}
          aria-hidden="true"
          className={`${handedOff ? '' : 'toast-enter '}rounded-btn bg-surface-2 px-4 py-3 text-center text-[0.9375rem] shadow-lg shadow-bg/30`}
        >
          {message}
        </div>
      )}
    </div>
  );
}

/** Owns queue timing; its outer live-region node never unmounts. */
export function Toast({
  deliveryTracker = sharedDeliveryTracker,
}: {
  deliveryTracker?: ToastDeliveryTracker;
}) {
  const toast = useUiStore((s) => s.toast);
  const sheet = useUiStore((s) => s.sheet);
  const clearToast = useUiStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 3200);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  return <ToastRegion active={sheet === null} deliveryTracker={deliveryTracker} />;
}
