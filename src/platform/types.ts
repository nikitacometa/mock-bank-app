/**
 * Platform seam (docs/spec.md §5.1): every platform capability the app touches
 * goes through this interface. Phase 1 ships adapter.web.ts; the TMA port
 * (phase 2) swaps in adapter.telegram.ts behind the same contract — screens
 * never learn which platform they run on.
 */
export type HapticKind = 'light' | 'success' | 'warning';

export interface MainButtonConfig {
  text: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface PlatformAdapter {
  isTelegram: boolean;
  getCurrentUser(): { displayName: string };
  haptic(kind: HapticKind): void;
  /**
   * Native main CTA (Telegram MainButton). Unsupported on web — the
   * PrimaryAction primitive falls back to a DOM button at the same call-site.
   */
  mainButton: {
    supported: boolean;
    show(config: MainButtonConfig): void;
    hide(): void;
  };
  /**
   * Arm the platform "back" gesture while a sheet is open. Web: popstate
   * sentinel; TMA: BackButton.show() + onClick. Returns disarm.
   */
  armBack(onBack: () => void): () => void;
}
