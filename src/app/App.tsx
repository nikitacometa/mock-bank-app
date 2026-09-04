import { useEffect, useRef } from 'react';
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
import { useI18n } from '@/i18n';
import { BootstrapGate } from './BootstrapGate';

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
  const refreshRates = useBankStore((s) => s.refreshRates);
  const recovered = useBankStore((s) => s.recoveredFromCorruption);
  const showToast = useUiStore((s) => s.showToast);
  const screen = useUiStore((s) => s.screen);
  const booted = useRef(false);
  const recoveryNoticeShown = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void settleNow();
    const startedWithFallback = useBankStore.getState().exchangeRates.source === 'fallback';
    void refreshRates().then((result) => {
      if (result === 'failed' && startedWithFallback) {
        showToast('app.ratesUnavailable');
      }
    });
  }, [settleNow, refreshRates, showToast]);

  useEffect(() => {
    if (!recovered || recoveryNoticeShown.current) return;
    recoveryNoticeShown.current = true;
    showToast('app.dataRecovered');
  }, [recovered, showToast]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void settleNow();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void settleNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [settleNow]);

  return (
    <div className="app-shell mx-auto max-w-[430px]" style={{ minHeight: 'var(--app-height)' }}>
      <main>
        {screen === 'home' && <Home />}
        {screen === 'history' && <History />}
        {screen === 'cards' && <Cards />}
      </main>
      <TabBar />
      <ActiveSheet />
      <Toast />
    </div>
  );
}

export function App() {
  const resetDemo = useBankStore((s) => s.resetDemo);
  const resetUi = useUiStore((s) => s.resetUi);
  const { locale } = useI18n();
  return (
    <ErrorBoundary
      locale={locale}
      onReset={async () => {
        await resetDemo();
        resetUi();
      }}
    >
      <PlatformProvider>
        <BootstrapGate>
          <Shell />
        </BootstrapGate>
      </PlatformProvider>
    </ErrorBoundary>
  );
}
