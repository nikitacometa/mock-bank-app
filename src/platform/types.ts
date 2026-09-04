import type { Currency } from '@/domain/types';
import type { AppLocale } from '@/i18n/catalog';

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

export interface PlatformUser {
  readonly displayName: string;
  /** Host identities are user data and must never pass through demo-fixture localization. */
  readonly source: 'demo' | 'host';
  /** Canonical decimal Telegram ID when the host supplied one safely. */
  readonly telegramId?: string;
}

export interface LaunchPreferences {
  readonly version: 1;
  /** Stable for one server-side preferences database generation. */
  readonly revisionEpoch: string;
  readonly revision: number;
  readonly locale: AppLocale;
  readonly primaryCurrency: Currency;
  readonly displayName: string;
  /** Telegram identifiers cross the API boundary as decimal strings. */
  readonly telegramId: string;
}

export interface PlatformAdapter {
  isTelegram: boolean;
  getCurrentUser(): PlatformUser;
  /**
   * Loads preferences bound to validated Telegram init data. Web returns null;
   * raw init data stays inside the platform adapter and is never persisted.
   */
  loadLaunchPreferences(signal?: AbortSignal): Promise<LaunchPreferences | null>;
  haptic(kind: HapticKind): void;
  copyText(text: string): Promise<boolean>;
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
