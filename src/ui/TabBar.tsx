import { useUiStore, type Screen } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { useI18n, type TranslationKey } from '@/i18n';
import { IconCards, IconHistory, IconHome, IconTransfer } from './icons';

const TABS: Array<{ screen: Screen; labelKey: TranslationKey; Icon: typeof IconHome }> = [
  { screen: 'home', labelKey: 'nav.home', Icon: IconHome },
  { screen: 'history', labelKey: 'nav.history', Icon: IconHistory },
];

export function TabBar() {
  const screen = useUiStore((s) => s.screen);
  const setScreen = useUiStore((s) => s.setScreen);
  const openGlobalTransfer = useUiStore((s) => s.openGlobalTransfer);
  const platform = usePlatform();
  const { t } = useI18n();

  const tab = (entry: (typeof TABS)[number]) => (
    <button
      key={entry.screen}
      className={`flex flex-1 flex-col items-center gap-1 py-2 transition-colors ${
        screen === entry.screen ? 'text-ink' : 'text-ink-3'
      }`}
      onClick={() => setScreen(entry.screen)}
      aria-current={screen === entry.screen ? 'page' : undefined}
    >
      <entry.Icon size={22} />
      <span className="text-[0.6875rem] leading-none">{t(entry.labelKey)}</span>
    </button>
  );

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line/60 bg-bg/85 backdrop-blur-xl"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <div className="mx-auto flex max-w-[430px] items-stretch px-2">
        {tab(TABS[0])}
        {tab(TABS[1])}
        <div className="flex flex-1 items-center justify-center">
          <button
            aria-label={t('nav.transfer')}
            className="-mt-5 flex size-14 items-center justify-center rounded-full bg-ivory text-bg shadow-lg shadow-bg/35 transition-transform active:scale-95"
            onClick={() => {
              platform.haptic('light');
              openGlobalTransfer();
            }}
          >
            <IconTransfer size={24} />
          </button>
        </div>
        <button
          className={`flex flex-1 flex-col items-center gap-1 py-2 transition-colors ${
            screen === 'cards' ? 'text-ink' : 'text-ink-3'
          }`}
          onClick={() => setScreen('cards')}
          aria-current={screen === 'cards' ? 'page' : undefined}
        >
          <IconCards size={22} />
          <span className="text-[0.6875rem] leading-none">{t('nav.cards')}</span>
        </button>
      </div>
    </nav>
  );
}
