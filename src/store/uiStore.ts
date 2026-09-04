import { create } from 'zustand';
import { CHECKING_ID } from '@/domain/seed';
import {
  translate,
  type AppLocale,
  type TranslationKey,
  type TranslationParams,
} from '@/i18n/catalog';
import {
  loadLocalePreference,
  onLocalePreferenceChange,
  saveLocalePreference,
} from './persistence';

export type Screen = 'home' | 'history' | 'cards';

export type Sheet =
  | { kind: 'transferOwn' }
  | { kind: 'transferContact' }
  | { kind: 'cardDetail'; cardId: string }
  | { kind: 'accountDetail'; accountId: string }
  | { kind: 'settings' };

interface ToastMessage {
  readonly id: number;
  readonly key: TranslationKey;
  readonly params?: TranslationParams;
}

let nextToastId = 1;

interface UiStore {
  locale: AppLocale;
  screen: Screen;
  sheet: Sheet | null;
  activeAccountId: string;
  toast: ToastMessage | null;
  toastQueue: ToastMessage[];

  setScreen(screen: Screen): void;
  setLocale(locale: AppLocale): boolean;
  reloadLocalePreference(): void;
  openSheet(sheet: Sheet): void;
  openGlobalTransfer(): void;
  closeSheet(): void;
  setActiveAccount(id: string): void;
  showToast(key: TranslationKey, params?: TranslationParams): void;
  clearToast(): void;
  resetUi(): void;
}

function syncDocumentLanguage(locale: AppLocale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  const description = document.querySelector?.<HTMLMetaElement>('meta[name="description"]');
  description?.setAttribute('content', translate(locale, 'app.metaDescription'));
}

const initialLocale = loadLocalePreference();
syncDocumentLanguage(initialLocale);

export const useUiStore = create<UiStore>()((set) => ({
  locale: initialLocale,
  screen: 'home',
  sheet: null,
  activeAccountId: CHECKING_ID,
  toast: null,
  toastQueue: [],

  setLocale: (locale) => {
    const saved = saveLocalePreference(locale);
    syncDocumentLanguage(locale);
    set({ locale });
    return saved;
  },
  reloadLocalePreference: () => {
    const locale = loadLocalePreference();
    syncDocumentLanguage(locale);
    set({ locale });
  },
  setScreen: (screen) => set({ screen, sheet: null }),
  openSheet: (sheet) => set({ sheet }),
  // Home must mount before the ledger changes so its paused HeroAmount keeps
  // the pre-transfer frame and reveals the new balance after the sheet closes.
  openGlobalTransfer: () => set({ screen: 'home', sheet: { kind: 'transferContact' } }),
  closeSheet: () => set({ sheet: null }),
  setActiveAccount: (activeAccountId) => set({ activeAccountId }),
  showToast: (key, params) =>
    set((state) => {
      const toast = { id: nextToastId++, key, params };
      return state.toast === null
        ? { toast }
        : { toastQueue: [...state.toastQueue, toast] };
    }),
  clearToast: () =>
    set((state) => ({
      toast: state.toastQueue[0] ?? null,
      toastQueue: state.toastQueue.slice(1),
    })),
  resetUi: () =>
    set({
      screen: 'home',
      sheet: null,
      activeAccountId: CHECKING_ID,
      toast: null,
      toastQueue: [],
    }),
}));

if (typeof window !== 'undefined') {
  onLocalePreferenceChange((locale) => {
    syncDocumentLanguage(locale);
    useUiStore.setState({ locale });
  });
}
