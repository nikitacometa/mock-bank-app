import { useEffect } from 'react';
import { PlatformProvider } from '@/platform/usePlatform';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { ErrorBoundary } from './ErrorBoundary';
import { formatMoney } from '@/domain/money';
import { balanceOf } from '@/domain/ledger';
import { CHECKING_ID } from '@/domain/seed';

function Shell() {
  const settleNow = useBankStore((s) => s.settleNow);
  const recovered = useBankStore((s) => s.recoveredFromCorruption);
  const showToast = useUiStore((s) => s.showToast);
  const balance = useBankStore((s) => balanceOf(s, CHECKING_ID));

  useEffect(() => {
    settleNow();
    if (recovered) showToast('Формат данных обновился — демо пересоздано');
    const onVisible = () => {
      if (document.visibilityState === 'visible') settleNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [settleNow, recovered, showToast]);

  // M0 skeleton — real screens land in M2-M5.
  return (
    <div className="flex flex-col items-center justify-center gap-3" style={{ minHeight: 'var(--app-height)' }}>
      <div className="kicker">Cometa · демо</div>
      <div className="num text-4xl font-medium">{formatMoney(balance)}</div>
    </div>
  );
}

export function App() {
  const resetDemo = useBankStore((s) => s.resetDemo);
  return (
    <ErrorBoundary onReset={resetDemo}>
      <PlatformProvider>
        <Shell />
      </PlatformProvider>
    </ErrorBoundary>
  );
}
