import { useEffect } from 'react';
import { PlatformProvider } from '@/platform/usePlatform';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { ErrorBoundary } from './ErrorBoundary';
import { TabBar } from '@/ui/TabBar';
import { Toast } from '@/ui/primitives/Toast';
import { Home } from '@/ui/screens/Home';
import { History } from '@/ui/screens/History';
import { Cards } from '@/ui/screens/Cards';
import { TransferSheet } from '@/ui/screens/sheets/TransferSheet';
import { CardDetailSheet } from '@/ui/screens/sheets/CardDetailSheet';
import { AccountDetailSheet } from '@/ui/screens/sheets/AccountDetailSheet';
import { SettingsSheet } from '@/ui/screens/sheets/SettingsSheet';

function ActiveSheet() {
  const sheet = useUiStore((s) => s.sheet);
  if (!sheet) return null;
  switch (sheet.kind) {
    case 'transferContact':
      return <TransferSheet initialMode="contact" />;
    case 'transferOwn':
      return <TransferSheet initialMode="own" />;
    case 'cardDetail':
      return <CardDetailSheet cardId={sheet.cardId} />;
    case 'accountDetail':
      return <AccountDetailSheet accountId={sheet.accountId} />;
    case 'settings':
      return <SettingsSheet />;
  }
}

function Shell() {
  const settleNow = useBankStore((s) => s.settleNow);
  const recovered = useBankStore((s) => s.recoveredFromCorruption);
  const showToast = useUiStore((s) => s.showToast);
  const screen = useUiStore((s) => s.screen);

  useEffect(() => {
    settleNow();
    if (recovered) showToast('Формат данных обновился — демо пересоздано');
    const onVisible = () => {
      if (document.visibilityState === 'visible') settleNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [settleNow, recovered, showToast]);

  return (
    <div className="mx-auto max-w-[430px]" style={{ minHeight: 'var(--app-height)' }}>
      {screen === 'home' && <Home />}
      {screen === 'history' && <History />}
      {screen === 'cards' && <Cards />}
      <TabBar />
      <ActiveSheet />
      <Toast />
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
