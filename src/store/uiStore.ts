import { create } from 'zustand';
import { CHECKING_ID } from '@/domain/seed';

export type Screen = 'home' | 'history' | 'cards';

export type Sheet =
  | { kind: 'transferOwn' }
  | { kind: 'transferContact' }
  | { kind: 'cardDetail'; cardId: string }
  | { kind: 'accountDetail'; accountId: string }
  | { kind: 'settings' };

interface UiStore {
  screen: Screen;
  sheet: Sheet | null;
  activeAccountId: string;
  toast: string | null;

  setScreen(screen: Screen): void;
  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  setActiveAccount(id: string): void;
  showToast(msg: string): void;
  clearToast(): void;
}

export const useUiStore = create<UiStore>()((set) => ({
  screen: 'home',
  sheet: null,
  activeAccountId: CHECKING_ID,
  toast: null,

  setScreen: (screen) => set({ screen, sheet: null }),
  openSheet: (sheet) => set({ sheet }),
  closeSheet: () => set({ sheet: null }),
  setActiveAccount: (activeAccountId) => set({ activeAccountId }),
  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
}));
