export const BOT_LOCALES = ['ru', 'en'] as const;
export type BotLocale = (typeof BOT_LOCALES)[number];

export const BOT_CURRENCIES = [
  'KZT',
  'THB',
  'VND',
  'RUB',
  'USD',
  'EUR',
  'IDR',
  'GEL',
] as const;
export type BotCurrency = (typeof BOT_CURRENCIES)[number];

export const ONBOARDING_STAGES = [
  'language',
  'currency',
  'custom_name',
  'complete',
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export interface UserPreferences {
  readonly locale: BotLocale;
  readonly primaryCurrency: BotCurrency;
  readonly displayName: string;
  readonly revision: number;
  readonly stage: OnboardingStage;
  readonly updatedAt: string;
}

export interface StoredUser extends UserPreferences {
  readonly telegramUserId: string;
}

export interface TelegramUserIdentity {
  readonly id: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly languageCode?: string;
}

export function isBotLocale(value: string): value is BotLocale {
  return (BOT_LOCALES as readonly string[]).includes(value);
}

export function isBotCurrency(value: string): value is BotCurrency {
  return (BOT_CURRENCIES as readonly string[]).includes(value);
}

export function preferredLocale(languageCode: string | undefined): BotLocale {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}
