import { useEffect } from 'react';
import { useUiStore } from '@/store/uiStore';

export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const clearToast = useUiStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 3200);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  if (!toast) return null;
  return (
    <div
      role="status"
      className="toast-enter fixed inset-x-4 z-[60] mx-auto max-w-[398px] rounded-btn bg-surface-2 px-4 py-3 text-center text-[0.9375rem] shadow-lg shadow-black/30"
      style={{ bottom: 'calc(var(--safe-bottom) + 5.5rem)' }}
    >
      {toast}
    </div>
  );
}
