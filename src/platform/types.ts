import type { BankCommand, BankCommandOutcome } from '@/domain/bankCommands';
import type { RecurringWarning } from '@/domain/recurring';
import type { BankState, Currency } from '@/domain/types';
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

export type ServerBankWarning = RecurringWarning;

export interface ServerBankRevision {
  readonly telegramId: string;
  readonly revisionEpoch: string;
  readonly revision: number;
  readonly digest: string;
  readonly state: BankState;
  readonly warnings: readonly ServerBankWarning[];
}

export type LaunchBankState =
  | {
      readonly contractVersion: 1;
      readonly mode: 'import_required';
      readonly telegramId: string;
    }
  | ({
      readonly contractVersion: 1;
      readonly mode: 'server';
    } & ServerBankRevision);

export interface LaunchState extends LaunchPreferences {
  readonly bank?: LaunchBankState;
}

export interface BankImportRequest {
  readonly version: 1;
  readonly importId: string;
  readonly stateVersion: 4 | 5;
  readonly state: BankState;
}

export interface BankImportResponse extends ServerBankRevision {
  readonly version: 1;
  readonly mode: 'server';
  readonly imported: boolean;
}

export type SuccessfulBankCommandOutcome = Extract<BankCommandOutcome, { readonly ok: true }>;

export interface BankCommandResponse extends ServerBankRevision {
  readonly version: 1;
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly outcome: SuccessfulBankCommandOutcome;
}

export interface BankRatesRefreshResponse extends ServerBankRevision {
  readonly version: 1;
  readonly updated: boolean;
}

export interface PlatformAdapter {
  isTelegram: boolean;
  getCurrentUser(): PlatformUser;
  /**
   * Opaque in-memory identity for the currently observed host session. The
   * value must not contain raw init data and must never be persisted.
   */
  getSessionFingerprint?(): string | undefined;
  /**
   * Loads preferences bound to validated Telegram init data. Web returns null;
   * raw init data stays inside the platform adapter and is never persisted.
   */
  loadLaunchState(signal?: AbortSignal): Promise<LaunchState | null>;
  /** Authenticated create-if-absent migration from this Telegram user's local snapshot. */
  importBankState(request: BankImportRequest, signal?: AbortSignal): Promise<BankImportResponse>;
  /** Executes one typed mutation against this Telegram user's canonical server ledger. */
  executeBankCommand(
    command: BankCommand,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<BankCommandResponse>;
  /** Refreshes canonical reference rates through the authenticated server authority. */
  refreshBankRates(
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<BankRatesRefreshResponse>;
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
