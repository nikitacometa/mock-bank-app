import { create } from 'zustand';
import { CHECKING_ID } from '@/domain/seed';
import type { Account, BankState, Contact } from '@/domain/types';
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

function accountTopology(account: Account): string {
  return JSON.stringify([
    account.id,
    account.type,
    account.role,
    account.status,
    account.currency,
  ]);
}

function contactTopology(contact: Contact): string {
  return contact.id;
}

function topologyChanged<T>(
  before: readonly T[],
  after: readonly T[],
  project: (value: T) => string,
): boolean {
  if (before.length !== after.length) return true;
  const beforeTopology = before.map(project).sort();
  const afterTopology = after.map(project).sort();
  return beforeTopology.some((value, index) => value !== afterTopology[index]);
}

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

  setScreen(screen: 'history'): void;
  navigateToActiveScreen(
    screen: Exclude<Screen, 'history'>,
    accounts: readonly Account[],
  ): void;
  setLocale(locale: AppLocale): boolean;
  reloadLocalePreference(): void;
  openSheet(sheet: Sheet): void;
  openGlobalTransfer(accounts: readonly Account[]): void;
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

function resolveActiveAccountId(
  accounts: readonly Account[],
  currentAccountId: string,
): string {
  const activeAccounts = accounts.filter((account) => account.status === 'active');
  return activeAccounts.some((account) => account.id === currentAccountId)
    ? currentAccountId
    : activeAccounts[0]?.id ?? CHECKING_ID;
}

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
  navigateToActiveScreen: (screen, accounts) =>
    set((state) => ({
      screen,
      sheet: null,
      activeAccountId: resolveActiveAccountId(accounts, state.activeAccountId),
    })),
  openSheet: (sheet) => set({ sheet }),
  // Home must mount before the ledger changes so its paused HeroAmount keeps
  // the pre-transfer frame and reveals the new balance after the sheet closes.
  openGlobalTransfer: (accounts) =>
    set((state) => ({
      screen: 'home',
      sheet: { kind: 'transferContact' },
      activeAccountId: resolveActiveAccountId(accounts, state.activeAccountId),
    })),
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

/**
 * Reconcile transient UI with every adopted ledger snapshot. History may keep
 * a reversibly closed account selected; active-only screens and action sheets
 * must never retain targets that the new snapshot can no longer use.
 */
export function reconcileUiAfterBankStateChange(
  previous: BankState,
  next: BankState,
): void {
  const ui = useUiStore.getState();
  const activeAccounts = next.accounts.filter((account) => account.status === 'active');
  const activeAccountIds = new Set(activeAccounts.map((account) => account.id));
  const selectableAccountIds = ui.screen === 'history'
    ? new Set(next.accounts.map((account) => account.id))
    : activeAccountIds;
  const activeAccountId = selectableAccountIds.has(ui.activeAccountId)
    ? ui.activeAccountId
    : activeAccounts[0]?.id ?? next.accounts[0]?.id ?? CHECKING_ID;
  const activeCardIds = new Set(
    next.cards
      .filter((card) => activeAccountIds.has(card.accountId))
      .map((card) => card.id),
  );
  const accountsChanged = topologyChanged(
    previous.accounts,
    next.accounts,
    accountTopology,
  );
  const contactsChanged = topologyChanged(
    previous.contacts,
    next.contacts,
    contactTopology,
  );

  let sheet = ui.sheet;
  const invalidSheet =
    (sheet?.kind === 'accountDetail' && !activeAccountIds.has(sheet.accountId)) ||
    (sheet?.kind === 'cardDetail' && !activeCardIds.has(sheet.cardId)) ||
    (sheet?.kind === 'transferOwn' &&
      (accountsChanged || activeAccounts.length < 2)) ||
    (sheet?.kind === 'transferContact' &&
      (accountsChanged ||
        contactsChanged ||
        !activeAccounts.some((account) => account.type === 'checking')));
  if (invalidSheet) sheet = null;

  if (activeAccountId !== ui.activeAccountId || sheet !== ui.sheet) {
    useUiStore.setState({ activeAccountId, sheet });
  }
}

if (typeof window !== 'undefined') {
  onLocalePreferenceChange((locale) => {
    syncDocumentLanguage(locale);
    useUiStore.setState({ locale });
  });
}
