import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { applyBankCommand, type BankCommand } from '../src/domain/bankCommands.js';
import { convertMoney } from '../src/domain/currency.js';
import {
  isAllowedEffectiveDate,
  normalizeUserText,
} from '../src/domain/inputValidation.js';
import { balanceOf } from '../src/domain/ledger.js';
import {
  formatMoney,
  parseAmountInput,
  parseBalanceInput,
  type MoneyLocale,
} from '../src/domain/money.js';
import { parseBankState } from '../src/domain/bankState.js';
import type {
  Account,
  BankState,
  Currency,
  RecurringDirection,
  RecurringRule,
} from '../src/domain/types.js';
import type { RecurringWarningDeliveryContext } from './bank-domain.js';
import { canonicalJsonDigest } from './canonical-json.js';
import { TelegramApiError } from './bot-api.js';
import {
  type BankDeliveryContext,
  BankAuthorityService,
  BankServiceError,
  type ServerBankPayload,
} from './bank-service.js';
import { escapeHtml } from './html.js';
import {
  BOT_CURRENCIES,
  type BotLocale,
  type StoredUser,
} from './model.js';
import {
  type BankOutboxItem,
  type ConversationReply,
  type ConversationSession,
  PreferencesRepository,
} from './repository.js';
import type { BankRequestLimiter } from './rate-limit.js';
import type {
  BotTransport,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramMessage,
} from './telegram.js';

const FLOW_TTL_MS = 24 * 60 * 60 * 1_000;
const FLOW_ID_PATTERN = /^[0-9a-f]{12}$/;
const CALLBACK_PATTERN = /^b:([0-9a-f]{12}):([a-z]{1,3})(?::([A-Za-z0-9_-]{1,12}))?$/;
const BANK_OUTBOX_INITIAL_BACKOFF_MS = 1_000;
const BANK_OUTBOX_MAX_BACKOFF_MS = 60_000;
const BANK_OUTBOX_MAX_RETRY_AFTER_MS = 60 * 60 * 1_000;
const COMMITTED_DOMAIN_FAILURES = new Set([
  'unknown_account',
  'unknown_card',
  'unknown_rule',
  'account_closed',
  'account_active',
  'checking_only',
  'invalid_account',
  'duplicate_account',
  'duplicate_currency',
  'non_zero_balance',
  'last_active_account',
  'invalid_rule_id',
  'duplicate_rule_id',
  'invalid_amount',
  'amount_too_large',
  'invalid_counterparty',
  'invalid_note',
  'invalid_category',
  'invalid_date',
  'invalid_display_name',
  'too_many_occurrences',
  'insufficient_funds',
  'capacity',
  'balance_overflow',
  'invalid_client_transfer_id',
  'same_account',
  'unknown_target',
  'invalid_exchange_rate',
  'converted_amount_too_small',
]);

type FlowKind = ConversationSession['flowKind'];
type FlowClock = () => Date;

export interface BankFlowLogger {
  warn(event: string, context?: Readonly<Record<string, string | number>>): void;
}

const silentLogger: BankFlowLogger = { warn: () => undefined };

interface DashboardDraft {
  readonly kind: 'dashboard';
}

interface TransactionDraft {
  readonly kind: 'transaction';
  readonly direction?: RecurringDirection;
  readonly accountIds?: readonly string[];
  readonly accountId?: string;
  readonly amountInput?: string;
  readonly counterparty?: string;
  readonly note?: string;
  readonly cadence?: 'once' | 'monthly';
  readonly effectiveDate?: string;
  readonly startYear?: number;
  readonly startMonth?: number;
  readonly anchorDay?: number;
  readonly previewThrough?: string;
  readonly previewBackfilled?: number;
  readonly previewBalanceMinor?: number;
}

interface AccountsDraft {
  readonly kind: 'accounts';
  readonly accountIds?: readonly string[];
  readonly accountId?: string;
  readonly currencies?: readonly Currency[];
  readonly currency?: Currency;
  readonly targetAmountInput?: string;
  readonly pendingAction?: 'add' | 'adjust' | 'close' | 'restore';
  readonly previewBalanceMinor?: number;
  readonly previewStatus?: Account['status'] | 'absent';
}

interface RecurringDraft {
  readonly kind: 'recurring';
  readonly ruleIds: readonly string[];
  readonly ruleId?: string;
  readonly pendingAction?: 'pause' | 'resume';
  readonly previewFingerprint?: string;
}

type FlowDraft = DashboardDraft | TransactionDraft | AccountsDraft | RecurringDraft;

interface ParsedCallback {
  readonly flowId: string;
  readonly action: string;
  readonly argument?: string;
}

interface OutboxPayload {
  readonly operationKind: string;
  readonly applied: boolean;
  readonly warnings: readonly unknown[];
  readonly warningContexts?: readonly RecurringWarningDeliveryContext[];
  readonly failure?: {
    readonly code: string;
    readonly availableMinor?: number;
    readonly requiredMinor?: number;
  };
  readonly deliveryContext?: BankDeliveryContext;
}

interface WarningOutboxPayload {
  readonly warnings: readonly unknown[];
  readonly warningContexts?: readonly RecurringWarningDeliveryContext[];
}

interface WizardUpdateContext {
  readonly sourceUpdateId: number;
  readonly telegramUserId: string;
  pendingSession?: Omit<ConversationSession, 'updatedAt'>;
}

function button(text: string, callbackData: string): InlineKeyboardButton {
  if (Buffer.byteLength(callbackData, 'utf8') > 64) {
    throw new RangeError('Telegram callback data exceeds 64 bytes');
  }
  return { text, callback_data: callbackData };
}

function webAppButton(text: string, webAppUrl: URL): InlineKeyboardButton {
  return { text, web_app: { url: webAppUrl.toString() } };
}

function rows<T>(values: readonly T[], width: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += width) {
    result.push(values.slice(index, index + width));
  }
  return result;
}

function callback(flowId: string, action: string, argument?: string): string {
  const value = argument === undefined
    ? `b:${flowId}:${action}`
    : `b:${flowId}:${action}:${argument}`;
  if (Buffer.byteLength(value, 'utf8') > 64) {
    throw new RangeError('Telegram callback data exceeds 64 bytes');
  }
  return value;
}

function parseCallback(value: string | undefined): ParsedCallback | null {
  if (value === undefined || Buffer.byteLength(value, 'utf8') > 64) return null;
  const match = CALLBACK_PATTERN.exec(value);
  if (!match) return null;
  return {
    flowId: match[1],
    action: match[2],
    ...(match[3] === undefined ? {} : { argument: match[3] }),
  };
}

function indexArgument(value: string | undefined, length: number): number | null {
  if (value === undefined || !/^\d{1,2}$/.test(value)) return null;
  const index = Number(value);
  return index >= 0 && index < length ? index : null;
}

function directionLabel(direction: RecurringDirection, locale: BotLocale): string {
  if (locale === 'ru') return direction === 'expense' ? 'Расход' : 'Поступление';
  return direction === 'expense' ? 'Expense' : 'Income';
}

function actionLabel(direction: RecurringDirection, locale: BotLocale): string {
  if (locale === 'ru') return direction === 'expense' ? 'Записать расход' : 'Записать поступление';
  return direction === 'expense' ? 'Record expense' : 'Record income';
}

function russianActiveAccountLabel(count: number): string {
  const category = new Intl.PluralRules('ru').select(count);
  if (category === 'one') return 'активный счёт';
  if (category === 'few') return 'активных счёта';
  return 'активных счетов';
}

const CURRENCY_ACCOUNT_NAMES: Readonly<Record<BotLocale, Readonly<Record<Currency, string>>>> = {
  ru: {
    KZT: 'Тенге',
    THB: 'Баты',
    VND: 'Донги',
    RUB: 'Рубли',
    USD: 'Доллары',
    EUR: 'Евро',
    IDR: 'Рупии',
    GEL: 'Лари',
  },
  en: {
    KZT: 'Tenge account',
    THB: 'Baht account',
    VND: 'Dong account',
    RUB: 'Ruble account',
    USD: 'US dollar account',
    EUR: 'Euro account',
    IDR: 'Rupiah account',
    GEL: 'Lari account',
  },
};

function accountDisplayName(account: Account, locale: BotLocale): string {
  if (account.role === 'primary-checking') return locale === 'ru' ? 'Текущий' : 'Current';
  if (account.role === 'primary-savings') return locale === 'ru' ? 'Накопительный' : 'Savings';
  if (account.role === 'companion-1' || account.role === 'companion-2') {
    return CURRENCY_ACCOUNT_NAMES[locale][account.currency];
  }
  if (account.name === `Everyday ${account.currency}`) {
    return locale === 'ru' ? 'Повседневный' : 'Everyday';
  }
  return account.name;
}

function accountLabel(account: Account, locale: BotLocale): string {
  return `${account.currency} · ${accountDisplayName(account, locale)}`;
}

function recurringStartWindow(now: Date): {
  readonly currentYear: number;
  readonly currentMonth: number;
  readonly earliestYear: number;
  readonly earliestMonth: number;
} {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const earliestIndex = currentYear * 12 + currentMonth - 1 - 119;
  return {
    currentYear,
    currentMonth,
    earliestYear: Math.floor(earliestIndex / 12),
    earliestMonth: earliestIndex % 12 + 1,
  };
}

function recurringMonthsForYear(year: number, now: Date): readonly number[] {
  const window = recurringStartWindow(now);
  if (year < window.earliestYear || year > window.currentYear) return [];
  const first = year === window.earliestYear ? window.earliestMonth : 1;
  const last = year === window.currentYear ? window.currentMonth : 12;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function canRepairTransactionByChangingAmount(error: string): boolean {
  return error === 'insufficient_funds' ||
    error === 'amount_too_large' ||
    error === 'balance_overflow';
}

function dateLabel(value: string, locale: BotLocale): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function yesterdayUtc(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return date.toISOString().slice(0, 10);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConversationReplyMarkup(value: unknown): InlineKeyboardMarkup | undefined {
  if (value === null) return undefined;
  if (!isObject(value) || !Array.isArray(value.inline_keyboard) || value.inline_keyboard.length > 100) {
    throw new Error('Invalid conversation reply markup');
  }
  const keyboard: InlineKeyboardButton[][] = [];
  for (const rawRow of value.inline_keyboard) {
    if (!Array.isArray(rawRow) || rawRow.length < 1 || rawRow.length > 8) {
      throw new Error('Invalid conversation reply keyboard row');
    }
    const row: InlineKeyboardButton[] = [];
    for (const rawButton of rawRow) {
      if (!isObject(rawButton) || typeof rawButton.text !== 'string') {
        throw new Error('Invalid conversation reply button');
      }
      const textLength = [...rawButton.text].length;
      if (textLength < 1 || textLength > 256) {
        throw new Error('Invalid conversation reply button text');
      }
      if (
        typeof rawButton.callback_data === 'string' &&
        Buffer.byteLength(rawButton.callback_data, 'utf8') > 0 &&
        Buffer.byteLength(rawButton.callback_data, 'utf8') <= 64
      ) {
        row.push({ text: rawButton.text, callback_data: rawButton.callback_data });
        continue;
      }
      const webApp = isObject(rawButton.web_app) && typeof rawButton.web_app.url === 'string'
        ? rawButton.web_app
        : null;
      if (webApp === null) throw new Error('Invalid conversation reply button action');
      const rawUrl = webApp.url;
      if (typeof rawUrl !== 'string') throw new Error('Invalid conversation reply web app URL');
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new Error('Invalid conversation reply web app URL');
      }
      if (url.protocol !== 'https:') throw new Error('Invalid conversation reply web app protocol');
      row.push({ text: rawButton.text, web_app: { url: url.toString() } });
    }
    keyboard.push(row);
  }
  return { inline_keyboard: keyboard };
}

function stringArray(value: unknown, maximum = 24): readonly string[] | undefined {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (BOT_CURRENCIES as readonly string[]).includes(value);
}

function parseWarningContexts(
  value: unknown,
  warningCount: number,
): readonly RecurringWarningDeliveryContext[] | null {
  if (!Array.isArray(value) || value.length > 64 || value.length !== warningCount) return null;
  const contexts: RecurringWarningDeliveryContext[] = [];
  for (const context of value) {
    if (!isObject(context)) return null;
    const keys = Object.keys(context);
    const reason = context.reason;
    const hasMoney = reason === 'insufficient_funds';
    const allowedKeys = hasMoney
      ? ['ruleId', 'reason', 'counterparty', 'currency', 'availableMinor', 'requiredMinor']
      : ['ruleId', 'reason', 'counterparty', 'currency'];
    if (
      keys.some((key) => !allowedKeys.includes(key)) ||
      typeof context.ruleId !== 'string' ||
      !/^rr_[A-Za-z0-9_.:-]{1,92}$/.test(context.ruleId) ||
      (reason !== 'capacity' && reason !== 'overflow' && reason !== 'insufficient_funds') ||
      typeof context.counterparty !== 'string' ||
      normalizeUserText(context.counterparty, 80) !== context.counterparty ||
      !isCurrency(context.currency) ||
      (hasMoney && (
        !Number.isSafeInteger(context.availableMinor) ||
        (context.availableMinor as number) < 0 ||
        !Number.isSafeInteger(context.requiredMinor) ||
        (context.requiredMinor as number) < 0
      ))
    ) return null;
    contexts.push({
      ruleId: context.ruleId,
      reason,
      counterparty: context.counterparty,
      currency: context.currency,
      ...(hasMoney
        ? {
            availableMinor: context.availableMinor as number,
            requiredMinor: context.requiredMinor as number,
          }
        : {}),
    });
  }
  return contexts;
}

function parseDraft(session: ConversationSession): FlowDraft | null {
  if (!isObject(session.draft) || typeof session.draft.kind !== 'string') return null;
  const source = session.draft;
  if (source.kind === 'dashboard') return { kind: 'dashboard' };
  if (source.kind === 'transaction') {
    const direction = source.direction;
    const cadence = source.cadence;
    if (
      (direction !== undefined && direction !== 'income' && direction !== 'expense') ||
      (cadence !== undefined && cadence !== 'once' && cadence !== 'monthly') ||
      (source.accountId !== undefined && typeof source.accountId !== 'string') ||
      (source.amountInput !== undefined && typeof source.amountInput !== 'string') ||
      (source.counterparty !== undefined && typeof source.counterparty !== 'string') ||
      (source.note !== undefined && typeof source.note !== 'string') ||
      (source.effectiveDate !== undefined && typeof source.effectiveDate !== 'string') ||
      (source.startYear !== undefined && !Number.isInteger(source.startYear)) ||
      (source.startMonth !== undefined && !Number.isInteger(source.startMonth)) ||
      (source.anchorDay !== undefined && !Number.isInteger(source.anchorDay))
      || (source.previewThrough !== undefined && typeof source.previewThrough !== 'string')
      || (source.previewBackfilled !== undefined && !Number.isSafeInteger(source.previewBackfilled))
      || (source.previewBalanceMinor !== undefined && !Number.isSafeInteger(source.previewBalanceMinor))
    ) return null;
    const accountIds = source.accountIds === undefined ? undefined : stringArray(source.accountIds);
    if (source.accountIds !== undefined && accountIds === undefined) return null;
    return {
      kind: 'transaction',
      ...(direction === undefined ? {} : { direction }),
      ...(accountIds === undefined ? {} : { accountIds }),
      ...(source.accountId === undefined ? {} : { accountId: source.accountId }),
      ...(source.amountInput === undefined ? {} : { amountInput: source.amountInput }),
      ...(source.counterparty === undefined ? {} : { counterparty: source.counterparty }),
      ...(source.note === undefined ? {} : { note: source.note }),
      ...(cadence === undefined ? {} : { cadence }),
      ...(source.effectiveDate === undefined ? {} : { effectiveDate: source.effectiveDate }),
      ...(source.startYear === undefined ? {} : { startYear: source.startYear as number }),
      ...(source.startMonth === undefined ? {} : { startMonth: source.startMonth as number }),
      ...(source.anchorDay === undefined ? {} : { anchorDay: source.anchorDay as number }),
      ...(source.previewThrough === undefined ? {} : { previewThrough: source.previewThrough }),
      ...(source.previewBackfilled === undefined ? {} : { previewBackfilled: source.previewBackfilled as number }),
      ...(source.previewBalanceMinor === undefined ? {} : { previewBalanceMinor: source.previewBalanceMinor as number }),
    };
  }
  if (source.kind === 'accounts') {
    const accountIds = source.accountIds === undefined ? undefined : stringArray(source.accountIds);
    const currencies = source.currencies === undefined
      ? undefined
      : Array.isArray(source.currencies) && source.currencies.length <= BOT_CURRENCIES.length && source.currencies.every(isCurrency)
        ? source.currencies
        : undefined;
    if (
      (source.accountIds !== undefined && accountIds === undefined) ||
      (source.currencies !== undefined && currencies === undefined) ||
      (source.accountId !== undefined && typeof source.accountId !== 'string') ||
      (source.currency !== undefined && !isCurrency(source.currency)) ||
      (source.targetAmountInput !== undefined && typeof source.targetAmountInput !== 'string') ||
      (source.previewBalanceMinor !== undefined && !Number.isSafeInteger(source.previewBalanceMinor)) ||
      (source.previewStatus !== undefined && source.previewStatus !== 'active' && source.previewStatus !== 'closed' && source.previewStatus !== 'absent') ||
      (source.pendingAction !== undefined && !['add', 'adjust', 'close', 'restore'].includes(String(source.pendingAction)))
    ) return null;
    return {
      kind: 'accounts',
      ...(accountIds === undefined ? {} : { accountIds }),
      ...(source.accountId === undefined ? {} : { accountId: source.accountId }),
      ...(currencies === undefined ? {} : { currencies }),
      ...(source.currency === undefined ? {} : { currency: source.currency }),
      ...(source.targetAmountInput === undefined ? {} : { targetAmountInput: source.targetAmountInput }),
      ...(source.previewBalanceMinor === undefined ? {} : { previewBalanceMinor: source.previewBalanceMinor as number }),
      ...(source.previewStatus === undefined ? {} : { previewStatus: source.previewStatus }),
      ...(source.pendingAction === undefined
        ? {}
        : { pendingAction: source.pendingAction as AccountsDraft['pendingAction'] }),
    };
  }
  if (source.kind === 'recurring') {
    const ruleIds = stringArray(source.ruleIds, 64);
    if (
      ruleIds === undefined ||
      (source.ruleId !== undefined && typeof source.ruleId !== 'string') ||
      (source.pendingAction !== undefined && source.pendingAction !== 'pause' && source.pendingAction !== 'resume') ||
      (source.previewFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(String(source.previewFingerprint)))
    ) return null;
    return {
      kind: 'recurring',
      ruleIds,
      ...(source.ruleId === undefined ? {} : { ruleId: source.ruleId }),
      ...(source.pendingAction === undefined ? {} : { pendingAction: source.pendingAction }),
      ...(source.previewFingerprint === undefined
        ? {}
        : { previewFingerprint: source.previewFingerprint as string }),
    };
  }
  return null;
}

function parseOutboxPayload(value: unknown): OutboxPayload | null {
  if (
    !isObject(value) ||
    typeof value.operationKind !== 'string' ||
    typeof value.applied !== 'boolean' ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 64
  ) return null;
  let failure: OutboxPayload['failure'];
  let deliveryContext: BankDeliveryContext | undefined;
  let warningContexts: readonly RecurringWarningDeliveryContext[] | undefined;
  if (value.failure !== undefined) {
    if (!isObject(value.failure) || typeof value.failure.code !== 'string') return null;
    const availableMinor = value.failure.availableMinor;
    const requiredMinor = value.failure.requiredMinor;
    if (
      (availableMinor !== undefined && !Number.isSafeInteger(availableMinor)) ||
      (requiredMinor !== undefined && !Number.isSafeInteger(requiredMinor))
    ) return null;
    failure = {
      code: value.failure.code,
      ...(availableMinor === undefined ? {} : { availableMinor: availableMinor as number }),
      ...(requiredMinor === undefined ? {} : { requiredMinor: requiredMinor as number }),
    };
  }
  if (value.deliveryContext !== undefined) {
    if (
      !isObject(value.deliveryContext) ||
      typeof value.deliveryContext.accountId !== 'string' ||
      value.deliveryContext.accountId.length < 1 ||
      value.deliveryContext.accountId.length > 96 ||
      (value.deliveryContext.currency !== undefined && !isCurrency(value.deliveryContext.currency))
    ) return null;
    deliveryContext = {
      accountId: value.deliveryContext.accountId,
      ...(value.deliveryContext.currency === undefined
        ? {}
        : { currency: value.deliveryContext.currency }),
    };
  }
  if (value.warningContexts !== undefined) {
    const parsed = parseWarningContexts(value.warningContexts, value.warnings.length);
    if (parsed === null) return null;
    warningContexts = parsed;
  }
  return {
    operationKind: value.operationKind,
    applied: value.applied,
    warnings: value.warnings,
    ...(warningContexts === undefined ? {} : { warningContexts }),
    ...(failure === undefined ? {} : { failure }),
    ...(deliveryContext === undefined ? {} : { deliveryContext }),
  };
}

function parseWarningOutboxPayload(value: unknown): WarningOutboxPayload | null {
  if (!isObject(value) || !Array.isArray(value.warnings) || value.warnings.length > 64) {
    return null;
  }
  if (value.warningContexts === undefined) return { warnings: value.warnings };
  const warningContexts = parseWarningContexts(value.warningContexts, value.warnings.length);
  return warningContexts === null
    ? null
    : { warnings: value.warnings, warningContexts };
}

function isPermanentSendError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code >= 400 && code < 500 && code !== 401 && code !== 404 && code !== 429;
}

function isFatalSendError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.errorCode ?? error.status;
  return code === 401 || code === 404;
}

function bankOutboxRetryMs(error: unknown, attempts: number): number {
  const exponential = Math.min(
    BANK_OUTBOX_MAX_BACKOFF_MS,
    BANK_OUTBOX_INITIAL_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8),
  );
  const retryAfter = error instanceof TelegramApiError
    ? Math.min((error.retryAfter ?? 0) * 1_000, BANK_OUTBOX_MAX_RETRY_AFTER_MS)
    : 0;
  return Math.max(exponential, retryAfter);
}

function moneyExample(currency: Currency, locale: BotLocale): string {
  if (currency === 'VND' || currency === 'IDR') return locale === 'ru' ? '125000' : '125,000';
  return locale === 'ru' ? '12500,50' : '12,500.50';
}

function operationSuccessText(kind: string, applied: boolean, locale: BotLocale): string {
  if (!applied) return locale === 'ru' ? '<b>Без изменений</b>' : '<b>No changes</b>';
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    record_transaction: ['Операция записана', 'Transaction recorded'],
    create_recurring: ['Ежемесячная операция сохранена', 'Monthly entry saved'],
    pause_recurring: ['Повторение приостановлено', 'Recurring entry paused'],
    resume_recurring: ['Повторение возобновлено', 'Recurring entry resumed'],
    add_account: ['Счёт добавлен', 'Account added'],
    adjust_balance: ['Баланс скорректирован', 'Balance adjusted'],
    close_account: ['Счёт закрыт', 'Account closed'],
    restore_account: ['Счёт восстановлен', 'Account restored'],
    set_primary_currency: ['Основная валюта обновлена', 'Primary currency updated'],
    set_display_name: ['Имя обновлено', 'Name updated'],
  };
  const label = labels[kind] ?? ['Изменение сохранено', 'Change saved'];
  return `<b>${locale === 'ru' ? label[0] : label[1]}</b>`;
}

function pauseReasonText(reason: RecurringRule['pauseReason'], locale: BotLocale): string {
  const ru: Readonly<Record<NonNullable<RecurringRule['pauseReason']>, string>> = {
    manual: 'приостановлено вами',
    account_closed: 'счёт закрыт',
    capacity: 'достигнут лимит истории',
    overflow: 'сумма вышла за безопасный предел',
    insufficient_funds: 'не хватило средств',
  };
  const en: Readonly<Record<NonNullable<RecurringRule['pauseReason']>, string>> = {
    manual: 'paused by you',
    account_closed: 'account is closed',
    capacity: 'history limit reached',
    overflow: 'amount exceeded the safe limit',
    insufficient_funds: 'insufficient funds',
  };
  if (reason === undefined) return locale === 'ru' ? 'приостановлено' : 'paused';
  return locale === 'ru' ? ru[reason] : en[reason];
}

function recurringReviewFingerprint(
  state: BankState,
  ruleId: string,
  through: string,
): string | null {
  const rule = state.recurringRules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) return null;
  const account = state.accounts.find((candidate) => candidate.id === rule.accountId);
  if (account === undefined) return null;
  return canonicalJsonDigest({
    version: 1,
    rule,
    account: {
      status: account.status,
      balanceMinor: balanceOf(state, account.id),
    },
    through,
    transactionCount: state.transactions.length,
  });
}

export class BankChatFlow {
  readonly #repository: PreferencesRepository;
  readonly #transport: BotTransport;
  readonly #webAppUrl: URL;
  readonly #service: BankAuthorityService<BankState, BankCommand>;
  readonly #logger: BankFlowLogger;
  readonly #clock: FlowClock;
  readonly #mutationLimiter: BankRequestLimiter;
  readonly #wizardUpdate = new AsyncLocalStorage<WizardUpdateContext>();

  constructor(
    repository: PreferencesRepository,
    transport: BotTransport,
    webAppUrl: URL,
    service: BankAuthorityService<BankState, BankCommand>,
    mutationLimiter: BankRequestLimiter,
    logger: BankFlowLogger = silentLogger,
    clock: FlowClock = () => new Date(),
  ) {
    this.#repository = repository;
    this.#transport = transport;
    this.#webAppUrl = webAppUrl;
    this.#service = service;
    this.#logger = logger;
    this.#clock = clock;
    this.#mutationLimiter = mutationLimiter;
  }

  reset(telegramUserId: string): void {
    this.#repository.deleteConversationSession(telegramUserId);
  }

  canonicalPreferences(telegramUserId: string): {
    readonly displayName: string;
    readonly primaryCurrency: Currency;
  } | null {
    const payload = this.#service.bootstrap(telegramUserId);
    if (payload === null || payload.mode !== 'server') return null;
    const state = this.#stateFrom(payload);
    return {
      displayName: state.profile.displayName,
      primaryCurrency: state.primaryCurrency,
    };
  }

  async applyCanonicalPreference(
    user: StoredUser,
    chatId: string,
    updateId: number,
    command: Extract<BankCommand, { kind: 'set_primary_currency' | 'set_display_name' }>,
    signal?: AbortSignal,
  ): Promise<'unavailable' | 'applied' | 'rejected'> {
    if (
      this.#repository.ledgerMode() !== 'server' ||
      this.#repository.getBankState(user.telegramUserId) === null
    ) return 'unavailable';
    return await this.#execute(user, chatId, updateId, command, undefined, signal)
      ? 'applied'
      : 'rejected';
  }

  async sendDashboard(
    chatId: string,
    user: StoredUser,
    updateId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#withWizardUpdate(updateId, user.telegramUserId, async () => {
      await this.#sendDashboard(chatId, user, signal);
    });
  }

  async #sendDashboard(
    chatId: string,
    user: StoredUser,
    signal?: AbortSignal,
  ): Promise<void> {
    this.reset(user.telegramUserId);
    const payload = this.#service.bootstrap(user.telegramUserId);
    if (payload === null || payload.mode === 'import_required') {
      this.reset(user.telegramUserId);
      await this.#sendActivation(chatId, user.locale, payload?.mode === 'import_required', signal);
      return;
    }
    const state = this.#stateFrom(payload);
    const session = this.#newSession(user.telegramUserId, 'accounts', 'dashboard', { kind: 'dashboard' });
    const activeAccounts = state.accounts.filter((account) => account.status === 'active');
    let totalUsd = 0;
    for (const account of activeAccounts) {
      const converted = convertMoney(
        balanceOf(state, account.id),
        account.currency,
        'USD',
        state.exchangeRates,
        'toward-zero',
      );
      const candidate = totalUsd + converted;
      if (!Number.isSafeInteger(candidate)) throw new RangeError('Portfolio USD total overflow');
      totalUsd = candidate;
    }
    const next = state.recurringRules
      .filter((rule) => rule.status === 'active')
      .sort((left, right) => left.nextOccurrence.localeCompare(right.nextOccurrence))[0];
    const name = escapeHtml(state.profile.displayName);
    const text = user.locale === 'ru'
      ? `<b>Cometa · ${name}</b>\n${escapeHtml(formatMoney(totalUsd, 'USD', 'ru'))} · ${activeAccounts.length} ${russianActiveAccountLabel(activeAccounts.length)}${next === undefined ? '' : `\nБлижайшее: <b>${escapeHtml(next.counterparty)}</b> · ${escapeHtml(dateLabel(next.nextOccurrence, 'ru'))}`}`
      : `<b>Cometa · ${name}</b>\n${escapeHtml(formatMoney(totalUsd, 'USD', 'en'))} · ${activeAccounts.length} active ${activeAccounts.length === 1 ? 'account' : 'accounts'}${next === undefined ? '' : `\nNext: <b>${escapeHtml(next.counterparty)}</b> · ${escapeHtml(dateLabel(next.nextOccurrence, 'en'))}`}`;
    await this.#send(chatId, text, {
      inline_keyboard: [
        [webAppButton(user.locale === 'ru' ? 'Открыть Cometa' : 'Open Cometa', this.#webAppUrl)],
        [
          button(user.locale === 'ru' ? 'Записать расход' : 'Record expense', callback(session.flowId, 'te')),
          button(user.locale === 'ru' ? 'Записать поступление' : 'Record income', callback(session.flowId, 'ti')),
        ],
        [
          button(user.locale === 'ru' ? 'Счета' : 'Accounts', callback(session.flowId, 'a')),
          button(user.locale === 'ru' ? 'Повторения' : 'Recurring', callback(session.flowId, 'r')),
        ],
        [button(user.locale === 'ru' ? 'Настройки' : 'Settings', callback(session.flowId, 's'))],
      ],
    }, signal);
  }

  async handleCommand(
    command: 'add' | 'accounts' | 'recurring' | 'cancel',
    message: TelegramMessage,
    user: StoredUser,
    updateId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#withWizardUpdate(updateId, user.telegramUserId, async () => {
      this.reset(user.telegramUserId);
      if (command === 'cancel') {
        await this.#sendDashboard(message.chat.id, user, signal);
        return;
      }
      const state = await this.#availableState(user, message.chat.id, signal);
      if (state === null) return;
      if (command === 'add') {
        await this.#startTransaction(message.chat.id, user, undefined, signal);
      } else if (command === 'accounts') {
        await this.#showAccounts(message.chat.id, user, state, signal);
      } else {
        await this.#showRecurring(message.chat.id, user, state, signal);
      }
    });
  }

  async handleMessage(
    message: TelegramMessage,
    user: StoredUser,
    updateId: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return await this.#withWizardUpdate(updateId, user.telegramUserId, async () => {
      const hadSession = this.#repository.hasConversationSessionRecord(user.telegramUserId);
      const session = this.#repository.getConversationSession(user.telegramUserId);
      if (message.text === undefined) return false;
      if (session === null) {
        if (!hadSession) return false;
        await this.#sendExpired(message.chat.id, user.locale, signal);
        return true;
      }
      const draft = parseDraft(session);
      if (draft === null) {
        this.reset(user.telegramUserId);
        return false;
      }
      if (draft.kind === 'transaction') {
        return this.#handleTransactionText(message, user, session, draft, signal);
      }
      if (draft.kind === 'accounts') {
        return this.#handleAccountText(message, user, session, draft, signal);
      }
      return false;
    });
  }

  async handleCallback(
    callbackQuery: TelegramCallbackQuery,
    updateId: number,
    user: StoredUser,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return await this.#withWizardUpdate(updateId, user.telegramUserId, async () => {
      if (!callbackQuery.data?.startsWith('b:')) return false;
      const parsed = parseCallback(callbackQuery.data);
      const session = this.#repository.getConversationSession(user.telegramUserId);
      const draft = session === null ? null : parseDraft(session);
      if (
        callbackQuery.message?.chat.type !== 'private' ||
        parsed === null ||
        session === null ||
        draft === null ||
        session.flowId !== parsed.flowId
      ) {
        await this.#answer(callbackQuery.id, user.locale === 'ru' ? 'Кнопка устарела' : 'This button has expired', signal);
        if (callbackQuery.message?.chat.type === 'private') {
          await this.#sendExpired(callbackQuery.message.chat.id, user.locale, signal);
        }
        return true;
      }
      await this.#answer(callbackQuery.id, undefined, signal);
      const chatId = callbackQuery.message.chat.id;
      if (parsed.action === 'bk') {
        await this.#sendDashboard(chatId, user, signal);
        return true;
      }
      if (draft.kind === 'dashboard') {
        await this.#handleDashboardCallback(chatId, user, session, parsed, signal);
        return true;
      }
      if (draft.kind === 'transaction') {
        await this.#handleTransactionCallback(chatId, user, updateId, session, draft, parsed, signal);
        return true;
      }
      if (draft.kind === 'accounts') {
        await this.#handleAccountsCallback(chatId, user, updateId, session, draft, parsed, signal);
        return true;
      }
      await this.#handleRecurringCallback(chatId, user, updateId, session, draft, parsed, signal);
      return true;
    });
  }

  async resumeConversationReply(
    updateId: number,
    telegramUserId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const exact = this.#repository.getConversationReply(updateId);
    if (exact !== null) {
      if (exact.telegramUserId !== telegramUserId) {
        throw new Error('Conversation reply update ID collision');
      }
      await this.#attemptConversationReply(exact, signal);
      return true;
    }
    // A crash can leave a reply pending before Poller records the source update.
    // Telegram may no longer replay that old update after a long outage, so a
    // newer update must drain the orphan before it can queue another reply.
    const pending = this.#repository.getPendingConversationReplyForUser(telegramUserId);
    if (pending !== null) {
      signal?.throwIfAborted();
      await this.#attemptConversationReply(pending, signal);
    }
    return false;
  }

  async flushConversationReplies(signal?: AbortSignal): Promise<void> {
    let fatal: unknown;
    for (const pending of this.#repository.listPendingConversationReplies()) {
      signal?.throwIfAborted();
      try {
        await this.#attemptConversationReply(pending, signal);
      } catch (error: unknown) {
        signal?.throwIfAborted();
        this.#logger.warn('telegram_conversation_reply_retry', {
          sourceUpdateId: pending.sourceUpdateId,
          errorType: error instanceof Error ? error.name : 'unknown',
        });
        if (isFatalSendError(error) && fatal === undefined) fatal = error;
      }
    }
    if (fatal !== undefined) throw fatal;
  }

  async flushBankOutbox(signal?: AbortSignal): Promise<void> {
    let fatal: unknown;
    for (const item of this.#repository.listDueBankOutbox()) {
      signal?.throwIfAborted();
      try {
        await this.#deliverBankOutbox(item, signal);
      } catch (error: unknown) {
        signal?.throwIfAborted();
        if (isPermanentSendError(error)) {
          this.#repository.completeBankOutbox(item.id);
          this.#logger.warn('telegram_bank_outbox_rejected', { outboxId: item.id });
          continue;
        }
        const attempts = Math.min(item.attempts + 1, 31);
        const retryMs = bankOutboxRetryMs(error, attempts);
        const nextAttemptAt = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.#clock().getTime() + retryMs,
        );
        if (!this.#repository.deferBankOutbox(item.id, attempts, nextAttemptAt)) {
          throw new Error('Bank outbox disappeared before retry', { cause: error });
        }
        this.#logger.warn('telegram_bank_outbox_retry', {
          outboxId: item.id,
          attempts,
          nextAttemptAt,
        });
        if (isFatalSendError(error) && fatal === undefined) fatal = error;
      }
    }
    if (fatal !== undefined) throw fatal;
  }

  async #handleDashboardCallback(
    chatId: string,
    user: StoredUser,
    session: ConversationSession,
    parsed: ParsedCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    if (parsed.action === 'te' || parsed.action === 'ti') {
      await this.#startTransaction(chatId, user, parsed.action === 'te' ? 'expense' : 'income', signal, session.flowId);
      return;
    }
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    if (parsed.action === 'a') {
      await this.#showAccounts(chatId, user, state, signal, session.flowId);
      return;
    }
    if (parsed.action === 'r') {
      await this.#showRecurring(chatId, user, state, signal, session.flowId);
      return;
    }
    if (parsed.action === 's') {
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>Настройки Cometa</b>\nВыберите, что изменить.'
        : '<b>Cometa settings</b>\nChoose what to change.', {
        inline_keyboard: [
          [
            button(user.locale === 'ru' ? 'Язык' : 'Language', 'settings:language'),
            button(user.locale === 'ru' ? 'Валюта' : 'Currency', 'settings:currency'),
          ],
          [button(user.locale === 'ru' ? 'Имя' : 'Name', 'name:custom')],
          [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(session.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    await this.#sendExpired(chatId, user.locale, signal);
  }

  async #startTransaction(
    chatId: string,
    user: StoredUser,
    direction?: RecurringDirection,
    signal?: AbortSignal,
    flowId?: string,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    const checking = state.accounts.filter((account) => account.status === 'active' && account.type === 'checking');
    if (checking.length === 0) {
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>Нет доступного счёта</b>\nДобавьте или восстановите текущий счёт через /accounts.'
        : '<b>No available account</b>\nAdd or restore a checking account with /accounts.', undefined, signal);
      return;
    }
    const session = this.#saveSession(
      user.telegramUserId,
      flowId ?? this.#flowId(),
      'transaction',
      direction === undefined ? 'transaction_direction' : 'transaction_account',
      { kind: 'transaction', ...(direction === undefined ? {} : { direction }), accountIds: checking.map((account) => account.id) },
    );
    if (direction === undefined) {
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>Новая операция</b>\nЧто записываем?'
        : '<b>New transaction</b>\nWhat are you recording?', {
        inline_keyboard: [[
          button(user.locale === 'ru' ? 'Расход' : 'Expense', callback(session.flowId, 'td', 'e')),
          button(user.locale === 'ru' ? 'Поступление' : 'Income', callback(session.flowId, 'td', 'i')),
        ], [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(session.flowId, 'bk'))]],
      }, signal);
      return;
    }
    await this.#sendAccountChoice(chatId, user, session, direction, checking, signal);
  }

  async #sendAccountChoice(
    chatId: string,
    user: StoredUser,
    session: ConversationSession,
    direction: RecurringDirection,
    accounts: readonly Account[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send(chatId, user.locale === 'ru'
      ? `<b>${directionLabel(direction, 'ru')}</b>\nВыберите текущий счёт.`
      : `<b>${directionLabel(direction, 'en')}</b>\nChoose a checking account.`, {
      inline_keyboard: [
        ...accounts.map((account, index) => [button(accountLabel(account, user.locale), callback(session.flowId, 'ac', String(index)))]),
        [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(session.flowId, 'bk'))],
      ],
    }, signal);
  }

  async #handleTransactionText(
    message: TelegramMessage,
    user: StoredUser,
    session: ConversationSession,
    draft: TransactionDraft,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const state = await this.#availableState(user, message.chat.id, signal);
    if (state === null) return true;
    const account = draft.accountId === undefined
      ? undefined
      : state.accounts.find((candidate) => candidate.id === draft.accountId);
    if (session.step === 'transaction_amount' && account !== undefined && draft.direction !== undefined) {
      const amountInput = normalizeUserText(message.text ?? '', 64);
      if (amountInput === null || parseAmountInput(amountInput, account.currency, user.locale) === null) {
        await this.#send(message.chat.id, user.locale === 'ru'
          ? `Введите сумму без знака, например <code>${moneyExample(account.currency, 'ru')}</code>.`
          : `Enter a positive amount, for example <code>${moneyExample(account.currency, 'en')}</code>.`, undefined, signal);
        return true;
      }
      this.#updateSession(session, 'transaction_counterparty', { ...draft, amountInput });
      await this.#send(message.chat.id, user.locale === 'ru'
        ? '<b>Кто получил или отправил?</b>\nНапример: Spotify, Арендодатель или Alex.'
        : '<b>Who sent or received it?</b>\nFor example: Spotify, Landlord, or Alex.', undefined, signal);
      return true;
    }
    if (session.step === 'transaction_counterparty') {
      const counterparty = normalizeUserText(message.text ?? '', 80);
      if (counterparty === null) {
        await this.#send(message.chat.id, user.locale === 'ru'
          ? 'Нужно название от 1 до 80 обычных символов.'
          : 'Use a name between 1 and 80 regular characters.', undefined, signal);
        return true;
      }
      this.#updateSession(session, 'transaction_note', { ...draft, counterparty });
      await this.#send(message.chat.id, user.locale === 'ru'
        ? '<b>Комментарий</b>\nОтправьте короткую причину или <code>-</code>, чтобы пропустить.'
        : '<b>Note</b>\nSend a short reason, or <code>-</code> to skip.', undefined, signal);
      return true;
    }
    if (session.step === 'transaction_note') {
      const note = message.text === '-' ? '' : normalizeUserText(message.text ?? '', 120);
      if (note === null) {
        await this.#send(message.chat.id, user.locale === 'ru'
          ? 'Комментарий должен быть короче 120 символов. Или отправьте <code>-</code>.'
          : 'Keep the note under 120 characters, or send <code>-</code>.', undefined, signal);
        return true;
      }
      const updated = this.#updateSession(session, 'transaction_cadence', { ...draft, note });
      await this.#send(message.chat.id, user.locale === 'ru'
        ? '<b>Как часто?</b>\nОдин раз или каждый месяц.'
        : '<b>How often?</b>\nOnce or every month.', {
        inline_keyboard: [[
          button(user.locale === 'ru' ? 'Один раз' : 'Once', callback(updated.flowId, 'co')),
          button(user.locale === 'ru' ? 'Ежемесячно' : 'Monthly', callback(updated.flowId, 'cm')),
        ], [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))]],
      }, signal);
      return true;
    }
    if (session.step === 'transaction_date_custom') {
      const date = message.text ?? '';
      if (!isAllowedEffectiveDate(date, this.#nowISO())) {
        await this.#send(message.chat.id, user.locale === 'ru'
          ? 'Нужна дата в формате <code>ГГГГ-ММ-ДД</code>, не в будущем и не старше 10 лет.'
          : 'Use <code>YYYY-MM-DD</code>, not in the future and no more than 10 years old.', undefined, signal);
        return true;
      }
      const updated = this.#updateSession(session, 'transaction_confirm', { ...draft, cadence: 'once', effectiveDate: date });
      await this.#sendTransactionReview(message.chat.id, user, updated, updated.draft as TransactionDraft, signal);
      return true;
    }
    if (session.step === 'transaction_edit_amount' && account !== undefined) {
      const amountInput = normalizeUserText(message.text ?? '', 64);
      if (amountInput === null || parseAmountInput(amountInput, account.currency, user.locale) === null) {
        await this.#send(message.chat.id, user.locale === 'ru'
          ? `Введите сумму без знака, например <code>${moneyExample(account.currency, 'ru')}</code>.`
          : `Enter a positive amount, for example <code>${moneyExample(account.currency, 'en')}</code>.`, undefined, signal);
        return true;
      }
      const updated = this.#updateSession(session, 'transaction_confirm', {
        ...draft,
        amountInput,
      });
      await this.#sendTransactionReview(
        message.chat.id,
        user,
        updated,
        updated.draft as TransactionDraft,
        signal,
      );
      return true;
    }
    return false;
  }

  async #handleTransactionCallback(
    chatId: string,
    user: StoredUser,
    updateId: number,
    session: ConversationSession,
    draft: TransactionDraft,
    parsed: ParsedCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    if (session.step === 'transaction_direction' && parsed.action === 'td') {
      const direction = parsed.argument === 'e' ? 'expense' : parsed.argument === 'i' ? 'income' : null;
      if (direction === null) return this.#sendExpired(chatId, user.locale, signal);
      const checking = state.accounts.filter((account) => draft.accountIds?.includes(account.id) && account.status === 'active' && account.type === 'checking');
      const updated = this.#updateSession(session, 'transaction_account', { ...draft, direction });
      await this.#sendAccountChoice(chatId, user, updated, direction, checking, signal);
      return;
    }
    if (session.step === 'transaction_account' && parsed.action === 'ac' && draft.direction !== undefined) {
      const accountIds = draft.accountIds ?? [];
      const index = indexArgument(parsed.argument, accountIds.length);
      const account = index === null ? undefined : state.accounts.find((candidate) => candidate.id === accountIds[index]);
      if (account === undefined || account.status !== 'active' || account.type !== 'checking') {
        return this.#sendExpired(chatId, user.locale, signal);
      }
      this.#updateSession(session, 'transaction_amount', { ...draft, accountId: account.id });
      await this.#send(chatId, user.locale === 'ru'
        ? `<b>Сумма · ${account.currency}</b>\nВведите без знака, например <code>${moneyExample(account.currency, 'ru')}</code>.\nДоступно: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'ru'))}`
        : `<b>Amount · ${account.currency}</b>\nEnter it without a sign, for example <code>${moneyExample(account.currency, 'en')}</code>.\nAvailable: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'en'))}`, undefined, signal);
      return;
    }
    if (session.step === 'transaction_cadence' && parsed.action === 'co') {
      const updated = this.#updateSession(session, 'transaction_date', { ...draft, cadence: 'once' });
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>Дата операции</b>\nВсе даты считаются по UTC.'
        : '<b>Transaction date</b>\nAll dates use UTC.', {
        inline_keyboard: [[
          button(user.locale === 'ru' ? 'Сегодня' : 'Today', callback(updated.flowId, 'dt')),
          button(user.locale === 'ru' ? 'Вчера' : 'Yesterday', callback(updated.flowId, 'dy')),
        ], [button(user.locale === 'ru' ? 'Ввести дату' : 'Enter date', callback(updated.flowId, 'dc'))],
        [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))]],
      }, signal);
      return;
    }
    if (session.step === 'transaction_cadence' && parsed.action === 'cm') {
      const updated = this.#updateSession(session, 'transaction_year', { ...draft, cadence: 'monthly' });
      const window = recurringStartWindow(this.#clock());
      const years = Array.from(
        { length: window.currentYear - window.earliestYear + 1 },
        (_, index) => window.currentYear - index,
      );
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>С какого года повторять?</b>\nКалендарь UTC. Исторические месяцы добавятся только после точного предпросмотра.'
        : '<b>Start year</b>\nUTC calendar. Past months are added only after an exact preview.', {
        inline_keyboard: [
          ...rows(years.map((value) => button(String(value), callback(updated.flowId, 'yr', String(value)))), 2),
          [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    if (session.step === 'transaction_date' && (parsed.action === 'dt' || parsed.action === 'dy' || parsed.action === 'dc')) {
      if (parsed.action === 'dc') {
        this.#updateSession(session, 'transaction_date_custom', draft);
        await this.#send(chatId, user.locale === 'ru'
          ? '<b>Дата операции</b>\nОтправьте <code>ГГГГ-ММ-ДД</code>.'
          : '<b>Transaction date</b>\nSend <code>YYYY-MM-DD</code>.', undefined, signal);
        return;
      }
      const effectiveDate = parsed.action === 'dt' ? todayUtc(this.#clock()) : yesterdayUtc(this.#clock());
      const updated = this.#updateSession(session, 'transaction_confirm', { ...draft, effectiveDate });
      await this.#sendTransactionReview(chatId, user, updated, updated.draft as TransactionDraft, signal);
      return;
    }
    if (session.step === 'transaction_year' && parsed.action === 'yr' && /^\d{4}$/.test(parsed.argument ?? '')) {
      const startYear = Number(parsed.argument);
      const months = recurringMonthsForYear(startYear, this.#clock());
      if (months.length === 0) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#updateSession(session, 'transaction_month', { ...draft, startYear });
      const names = user.locale === 'ru'
        ? ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']
        : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>Стартовый месяц · UTC</b>'
        : '<b>Start month · UTC</b>', {
        inline_keyboard: [
          ...rows(months.map((month) => button(names[month - 1], callback(updated.flowId, 'mo', String(month)))), 3),
          [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    if (session.step === 'transaction_month' && parsed.action === 'mo' && draft.startYear !== undefined && /^\d{1,2}$/.test(parsed.argument ?? '')) {
      const startMonth = Number(parsed.argument);
      if (!recurringMonthsForYear(draft.startYear, this.#clock()).includes(startMonth)) {
        return this.#sendExpired(chatId, user.locale, signal);
      }
      const updated = this.#updateSession(session, 'transaction_day', { ...draft, startMonth });
      await this.#send(chatId, user.locale === 'ru'
        ? '<b>День списания или поступления</b>\nДля короткого месяца дата сдвинется на его последний день.'
        : '<b>Billing day</b>\nShort months use their final calendar day.', {
        inline_keyboard: [
          ...rows(Array.from({ length: 31 }, (_, index) => button(String(index + 1), callback(updated.flowId, 'da', String(index + 1)))), 4),
          [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    if (session.step === 'transaction_day' && parsed.action === 'da' && draft.startYear !== undefined && draft.startMonth !== undefined && /^\d{1,2}$/.test(parsed.argument ?? '')) {
      const anchorDay = Number(parsed.argument);
      if (anchorDay < 1 || anchorDay > 31) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#updateSession(session, 'transaction_confirm', { ...draft, anchorDay });
      await this.#sendTransactionReview(chatId, user, updated, updated.draft as TransactionDraft, signal);
      return;
    }
    if (session.step === 'transaction_confirm' && parsed.action === 'am') {
      const account = state.accounts.find((candidate) => candidate.id === draft.accountId);
      if (account === undefined || account.status !== 'active' || account.type !== 'checking') {
        return this.#sendExpired(chatId, user.locale, signal);
      }
      this.#updateSession(session, 'transaction_edit_amount', draft);
      await this.#send(chatId, user.locale === 'ru'
        ? `<b>Новая сумма · ${account.currency}</b>\nВведите новую сумму больше нуля. Проверим итог перед сохранением.`
        : `<b>New amount · ${account.currency}</b>\nEnter a new positive amount. We’ll check the total before saving.`, undefined, signal);
      return;
    }
    if (session.step === 'transaction_confirm' && parsed.action === 'cf') {
      const command = this.#transactionCommand(session.flowId, draft, user.locale);
      if (command === null) return this.#sendExpired(chatId, user.locale, signal);
      if (this.#isExactTelegramCommand(user.telegramUserId, updateId, command)) {
        await this.#execute(user, chatId, updateId, command, session, signal);
        return;
      }
      const account = state.accounts.find((candidate) => candidate.id === draft.accountId);
      if (account === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const preview = applyBankCommand(state, command, { nowISO: this.#nowISO() });
      if (!preview.ok) {
        await this.#send(
          chatId,
          this.#domainErrorText(
            preview.error,
            user.locale,
            account.currency,
            preview.availableMinor,
            preview.requiredMinor,
          ),
          {
            inline_keyboard: [
              ...(canRepairTransactionByChangingAmount(preview.error)
                ? [[button(user.locale === 'ru' ? 'Изменить сумму' : 'Edit amount', callback(session.flowId, 'am'))]]
                : []),
              [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(session.flowId, 'bk'))],
            ],
          },
          signal,
        );
        return;
      }
      if (
        draft.previewThrough !== todayUtc(this.#clock()) ||
        draft.previewBackfilled !== (preview.backfilled ?? 0) ||
        draft.previewBalanceMinor !== balanceOf(preview.state, account.id)
      ) {
        await this.#sendTransactionReview(chatId, user, session, draft, signal);
        return;
      }
      await this.#execute(user, chatId, updateId, command, session, signal);
      return;
    }
    await this.#sendExpired(chatId, user.locale, signal);
  }

  async #sendTransactionReview(
    chatId: string,
    user: StoredUser,
    session: ConversationSession,
    draft: TransactionDraft,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    const account = state.accounts.find((candidate) => candidate.id === draft.accountId);
    if (account === undefined || draft.direction === undefined || draft.amountInput === undefined || draft.counterparty === undefined) {
      await this.#sendExpired(chatId, user.locale, signal);
      return;
    }
    const reviewSession = this.#replaceFlowSession(session, 'transaction_confirm', draft);
    const command = this.#transactionCommand(reviewSession.flowId, draft, user.locale);
    if (command === null) {
      await this.#sendExpired(chatId, user.locale, signal);
      return;
    }
    const preview = applyBankCommand(state, command, { nowISO: this.#nowISO() });
    if (!preview.ok) {
      await this.#send(chatId, this.#domainErrorText(preview.error, user.locale, account.currency, preview.availableMinor, preview.requiredMinor), {
        inline_keyboard: [
          ...(canRepairTransactionByChangingAmount(preview.error)
            ? [[button(user.locale === 'ru' ? 'Изменить сумму' : 'Edit amount', callback(reviewSession.flowId, 'am'))]]
            : []),
          [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(reviewSession.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    const amount = parseAmountInput(draft.amountInput, account.currency, user.locale);
    if (amount === null) return this.#sendExpired(chatId, user.locale, signal);
    const projected = balanceOf(preview.state, account.id);
    const backfilled = preview.backfilled ?? 0;
    const reviewedSession =
      draft.previewThrough === todayUtc(this.#clock()) &&
      draft.previewBackfilled === backfilled &&
      draft.previewBalanceMinor === projected
        ? reviewSession
        : this.#updateSession(reviewSession, 'transaction_confirm', {
            ...draft,
            previewThrough: todayUtc(this.#clock()),
            previewBackfilled: backfilled,
            previewBalanceMinor: projected,
          });
    const note = draft.note ? escapeHtml(draft.note) : user.locale === 'ru' ? 'без комментария' : 'no note';
    const recurrence = command.kind === 'record_transaction'
      ? user.locale === 'ru'
        ? `Один раз · ${escapeHtml(dateLabel(command.effectiveDate, 'ru'))}`
        : `Once · ${escapeHtml(dateLabel(command.effectiveDate, 'en'))}`
      : user.locale === 'ru'
        ? `Ежемесячно с ${String(command.startMonth).padStart(2, '0')}.${command.startYear}, день ${command.anchorDay} · UTC\nИстория по ${escapeHtml(dateLabel(todayUtc(this.#clock()), 'ru'))}: <b>${backfilled}</b> операций · ${escapeHtml(formatMoney(amount * backfilled, account.currency, 'ru'))}`
        : `Monthly from ${command.startYear}-${String(command.startMonth).padStart(2, '0')}, day ${command.anchorDay} · UTC\nBackfill through ${escapeHtml(dateLabel(todayUtc(this.#clock()), 'en'))}: <b>${backfilled}</b> entries · ${escapeHtml(formatMoney(amount * backfilled, account.currency, 'en'))}`;
    const text = user.locale === 'ru'
      ? `<b>Проверьте ${directionLabel(draft.direction, 'ru').toLowerCase()}</b>\nСчёт: <b>${escapeHtml(accountLabel(account, 'ru'))}</b>\nСумма: <b>${escapeHtml(formatMoney(amount, account.currency, 'ru'))}</b>\nКому / от кого: <b>${escapeHtml(draft.counterparty)}</b>\nКомментарий: ${note}\n${recurrence}\nБаланс после: <b>${escapeHtml(formatMoney(projected, account.currency, 'ru'))}</b>\n\nЭто запись в вымышленном демо-журнале. Деньги не переводятся.`
      : `<b>Review ${directionLabel(draft.direction, 'en').toLowerCase()}</b>\nAccount: <b>${escapeHtml(accountLabel(account, 'en'))}</b>\nAmount: <b>${escapeHtml(formatMoney(amount, account.currency, 'en'))}</b>\nTo / from: <b>${escapeHtml(draft.counterparty)}</b>\nNote: ${note}\n${recurrence}\nBalance after: <b>${escapeHtml(formatMoney(projected, account.currency, 'en'))}</b>\n\nThis only records a fictional demo entry. No money moves.`;
    await this.#send(chatId, text, {
      inline_keyboard: [[button(actionLabel(draft.direction, user.locale), callback(reviewedSession.flowId, 'cf'))], [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(reviewedSession.flowId, 'bk'))]],
    }, signal);
  }

  #transactionCommand(flowId: string, draft: TransactionDraft, locale: MoneyLocale): Extract<BankCommand, { kind: 'record_transaction' | 'create_recurring' }> | null {
    if (
      draft.accountId === undefined ||
      draft.direction === undefined ||
      draft.amountInput === undefined ||
      draft.counterparty === undefined ||
      draft.cadence === undefined
    ) return null;
    const common = {
      accountId: draft.accountId,
      direction: draft.direction,
      amountInput: draft.amountInput,
      locale,
      counterparty: draft.counterparty,
      ...(draft.note ? { note: draft.note } : {}),
      category:
        draft.direction === 'income'
          ? 'transfer'
          : draft.cadence === 'monthly'
            ? 'subscriptions'
            : 'other',
    } as const;
    if (draft.cadence === 'once') {
      return draft.effectiveDate === undefined ? null : { kind: 'record_transaction', ...common, effectiveDate: draft.effectiveDate };
    }
    return draft.startYear === undefined || draft.startMonth === undefined || draft.anchorDay === undefined
      ? null
      : { kind: 'create_recurring', ruleId: `rr_bot_${flowId}`, ...common, startYear: draft.startYear, startMonth: draft.startMonth, anchorDay: draft.anchorDay };
  }

  async #showAccounts(
    chatId: string,
    user: StoredUser,
    state: BankState,
    signal?: AbortSignal,
    flowId?: string,
  ): Promise<void> {
    const accounts = [...state.accounts].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'));
    const session = this.#saveSession(user.telegramUserId, flowId ?? this.#flowId(), 'accounts', 'accounts_list', {
      kind: 'accounts',
      accountIds: accounts.map((account) => account.id),
    });
    const active = accounts.filter((account) => account.status === 'active').length;
    const closed = accounts.length - active;
    const text = user.locale === 'ru'
      ? `<b>Счета</b>\n${active} активных · ${closed} закрытых\n\nЗакрытие обратимо и не удаляет историю.`
      : `<b>Accounts</b>\n${active} active · ${closed} closed\n\nClosing is reversible and keeps the full history.`;
    await this.#send(chatId, text, {
      inline_keyboard: [
        ...accounts.map((account, index) => [button(
          `${account.status === 'closed' ? '○ ' : ''}${accountLabel(account, user.locale)} · ${formatMoney(balanceOf(state, account.id), account.currency, user.locale)}`,
          callback(session.flowId, 'ad', String(index)),
        )]),
        [button(user.locale === 'ru' ? 'Добавить счёт' : 'Add account', callback(session.flowId, 'aa'))],
        [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(session.flowId, 'bk'))],
      ],
    }, signal);
  }

  async #handleAccountText(
    message: TelegramMessage,
    user: StoredUser,
    session: ConversationSession,
    draft: AccountsDraft,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (session.step !== 'account_adjust_amount' || draft.accountId === undefined) return false;
    const state = await this.#availableState(user, message.chat.id, signal);
    if (state === null) return true;
    const account = state.accounts.find((candidate) => candidate.id === draft.accountId);
    if (account === undefined || account.status !== 'active') {
      await this.#sendExpired(message.chat.id, user.locale, signal);
      return true;
    }
    const targetAmountInput = normalizeUserText(message.text ?? '', 64);
    if (
      targetAmountInput === null ||
      parseBalanceInput(targetAmountInput, account.currency, user.locale) === null
    ) {
      await this.#send(message.chat.id, user.locale === 'ru'
        ? `Введите сумму от нуля, например <code>${moneyExample(account.currency, 'ru')}</code>.`
        : `Enter zero or a positive amount, for example <code>${moneyExample(account.currency, 'en')}</code>.`, undefined, signal);
      return true;
    }
    const updated = this.#updateSession(session, 'account_confirm', {
      ...draft,
      targetAmountInput,
      pendingAction: 'adjust',
    });
    await this.#sendAccountReview(message.chat.id, user, updated, updated.draft as AccountsDraft, signal);
    return true;
  }

  async #handleAccountsCallback(
    chatId: string,
    user: StoredUser,
    updateId: number,
    session: ConversationSession,
    draft: AccountsDraft,
    parsed: ParsedCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    if (session.step === 'accounts_list' && parsed.action === 'ad') {
      const ids = draft.accountIds ?? [];
      const index = indexArgument(parsed.argument, ids.length);
      const account = index === null ? undefined : state.accounts.find((candidate) => candidate.id === ids[index]);
      if (account === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#updateSession(session, 'account_detail', { ...draft, accountId: account.id });
      await this.#sendAccountDetail(chatId, user, updated, state, account, signal);
      return;
    }
    if (session.step === 'accounts_list' && parsed.action === 'aa') {
      const activeCurrencies = new Set(state.accounts.filter((account) => account.status === 'active' && account.type === 'checking').map((account) => account.currency));
      const closedCurrencies = new Set(state.accounts.filter((account) => account.status === 'closed' && account.type === 'checking').map((account) => account.currency));
      const currencies = BOT_CURRENCIES.filter((currency) => !activeCurrencies.has(currency) && !closedCurrencies.has(currency));
      const updated = this.#updateSession(session, 'account_currency', { kind: 'accounts', currencies });
      const restoreHint = closedCurrencies.size === 0 ? '' : user.locale === 'ru'
        ? '\nЗакрытую валюту восстановите из списка счетов.'
        : '\nRestore a closed currency from the account list.';
      await this.#send(chatId, user.locale === 'ru'
        ? `<b>Новый текущий счёт</b>\nОн откроется с нулевым балансом.${restoreHint}`
        : `<b>New checking account</b>\nIt opens with a zero balance.${restoreHint}`, {
        inline_keyboard: [
          ...rows(currencies.map((currency, index) => button(currency, callback(updated.flowId, 'cu', String(index)))), 2),
          [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(updated.flowId, 'bk'))],
        ],
      }, signal);
      return;
    }
    if (session.step === 'account_currency' && parsed.action === 'cu') {
      const currencies = draft.currencies ?? [];
      const index = indexArgument(parsed.argument, currencies.length);
      const currency = index === null ? undefined : currencies[index];
      if (currency === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#updateSession(session, 'account_confirm', { kind: 'accounts', currency, pendingAction: 'add' });
      await this.#sendAccountReview(chatId, user, updated, updated.draft as AccountsDraft, signal);
      return;
    }
    if (session.step === 'account_detail' && draft.accountId !== undefined) {
      const account = state.accounts.find((candidate) => candidate.id === draft.accountId);
      if (account === undefined) return this.#sendExpired(chatId, user.locale, signal);
      if (parsed.action === 'aj' && account.status === 'active') {
        this.#updateSession(session, 'account_adjust_amount', { ...draft, pendingAction: 'adjust' });
        await this.#send(chatId, user.locale === 'ru'
          ? `<b>Новый баланс · ${account.currency}</b>\nТекущий: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'ru'))}\nВведите целевую сумму от нуля.${account.type === 'savings' ? '\nПроценты сначала начислятся по текущий UTC-момент.' : ''}`
          : `<b>New balance · ${account.currency}</b>\nCurrent: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'en'))}\nEnter a non-negative target.${account.type === 'savings' ? '\nInterest settles through the current UTC instant first.' : ''}`, undefined, signal);
        return;
      }
      if (parsed.action === 'cl' && account.status === 'active') {
        const updated = this.#updateSession(session, 'account_confirm', { ...draft, pendingAction: 'close' });
        await this.#sendAccountReview(chatId, user, updated, updated.draft as AccountsDraft, signal);
        return;
      }
      if (parsed.action === 'rs' && account.status === 'closed') {
        const updated = this.#updateSession(session, 'account_confirm', { ...draft, pendingAction: 'restore' });
        await this.#sendAccountReview(chatId, user, updated, updated.draft as AccountsDraft, signal);
        return;
      }
    }
    if (session.step === 'account_confirm' && parsed.action === 'cf') {
      const command = this.#accountCommand(session.flowId, draft, user.locale);
      if (command === null) return this.#sendExpired(chatId, user.locale, signal);
      if (this.#isExactTelegramCommand(user.telegramUserId, updateId, command)) {
        await this.#execute(user, chatId, updateId, command, session, signal);
        return;
      }
      const account = 'accountId' in command
        ? state.accounts.find((candidate) => candidate.id === command.accountId)
        : undefined;
      const preview = applyBankCommand(state, command, { nowISO: this.#nowISO() });
      if (!preview.ok) {
        await this.#sendAccountReview(chatId, user, session, draft, signal);
        return;
      }
      const currentStatus = account?.status ?? 'absent';
      const currentBalanceMinor = account === undefined ? 0 : balanceOf(state, account.id);
      if (
        draft.previewStatus !== currentStatus ||
        draft.previewBalanceMinor !== currentBalanceMinor
      ) {
        await this.#sendAccountReview(chatId, user, session, draft, signal);
        return;
      }
      await this.#execute(user, chatId, updateId, command, session, signal);
      return;
    }
    await this.#sendExpired(chatId, user.locale, signal);
  }

  async #sendAccountDetail(
    chatId: string,
    user: StoredUser,
    session: ConversationSession,
    state: BankState,
    account: Account,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = account.status === 'active'
      ? user.locale === 'ru' ? 'Активен' : 'Active'
      : user.locale === 'ru' ? 'Закрыт, можно восстановить' : 'Closed, can be restored';
    const text = user.locale === 'ru'
      ? `<b>${escapeHtml(accountDisplayName(account, 'ru'))} · ${account.currency}</b>\n${status}\nБаланс: <b>${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'ru'))}</b>\nТип: ${account.type === 'savings' ? 'накопительный' : 'текущий'}\n\nИстория сохраняется и после закрытия.`
      : `<b>${escapeHtml(accountDisplayName(account, 'en'))} · ${account.currency}</b>\n${status}\nBalance: <b>${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'en'))}</b>\nType: ${account.type === 'savings' ? 'savings' : 'checking'}\n\nHistory remains available after closing.`;
    const controls = account.status === 'active'
      ? [
          [button(user.locale === 'ru' ? 'Скорректировать баланс' : 'Adjust balance', callback(session.flowId, 'aj'))],
          [button(user.locale === 'ru' ? 'Закрыть счёт' : 'Close account', callback(session.flowId, 'cl'))],
        ]
      : [[button(user.locale === 'ru' ? 'Восстановить счёт' : 'Restore account', callback(session.flowId, 'rs'))]];
    await this.#send(chatId, text, {
      inline_keyboard: [...controls, [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(session.flowId, 'bk'))]],
    }, signal);
  }

  async #sendAccountReview(
    chatId: string,
    user: StoredUser,
    session: ConversationSession,
    draft: AccountsDraft,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    const reviewSession = this.#replaceFlowSession(session, 'account_confirm', draft);
    const command = this.#accountCommand(reviewSession.flowId, draft, user.locale);
    if (command === null) return this.#sendExpired(chatId, user.locale, signal);
    const preview = applyBankCommand(state, command, { nowISO: this.#nowISO() });
    const account = 'accountId' in command
      ? state.accounts.find((candidate) => candidate.id === command.accountId)
      : undefined;
    if (!preview.ok) {
      await this.#send(chatId, this.#domainErrorText(preview.error, user.locale, account?.currency, preview.availableMinor, preview.requiredMinor), {
        inline_keyboard: [[button(user.locale === 'ru' ? 'На главную' : 'Dashboard', callback(reviewSession.flowId, 'bk'))]],
      }, signal);
      return;
    }
    const currentStatus = account?.status ?? 'absent';
    const currentBalanceMinor = account === undefined ? 0 : balanceOf(state, account.id);
    const reviewedSession =
      draft.previewStatus === currentStatus &&
      draft.previewBalanceMinor === currentBalanceMinor
        ? reviewSession
        : this.#updateSession(reviewSession, 'account_confirm', {
            ...draft,
            previewStatus: currentStatus,
            previewBalanceMinor: currentBalanceMinor,
          });
    let title: string;
    let details: string;
    let confirm: string;
    if (command.kind === 'add_account') {
      title = user.locale === 'ru' ? 'Открыть демо-счёт?' : 'Open demo account?';
      details = user.locale === 'ru'
        ? `Валюта: <b>${command.currency}</b>\nТип: текущий\nНачальный баланс: <b>${escapeHtml(formatMoney(0, command.currency, 'ru'))}</b>`
        : `Currency: <b>${command.currency}</b>\nType: checking\nOpening balance: <b>${escapeHtml(formatMoney(0, command.currency, 'en'))}</b>`;
      confirm = user.locale === 'ru' ? 'Добавить счёт' : 'Add account';
    } else if (command.kind === 'adjust_balance' && account !== undefined) {
      const target = parseBalanceInput(command.targetAmountInput, account.currency, user.locale);
      if (target === null) return this.#sendExpired(chatId, user.locale, signal);
      title = user.locale === 'ru' ? 'Скорректировать баланс?' : 'Adjust balance?';
      details = user.locale === 'ru'
        ? `Счёт: <b>${escapeHtml(accountLabel(account, 'ru'))}</b>\nСейчас: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'ru'))}\nСтанет: <b>${escapeHtml(formatMoney(target, account.currency, 'ru'))}</b>\nБудет добавлена отдельная строка корректировки.${account.type === 'savings' ? '\nПроценты начисляются до корректировки.' : ''}`
        : `Account: <b>${escapeHtml(accountLabel(account, 'en'))}</b>\nCurrent: ${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'en'))}\nTarget: <b>${escapeHtml(formatMoney(target, account.currency, 'en'))}</b>\nA separate adjustment row will be added.${account.type === 'savings' ? '\nInterest settles before the adjustment.' : ''}`;
      confirm = user.locale === 'ru' ? 'Скорректировать' : 'Adjust';
    } else if (command.kind === 'close_account' && account !== undefined) {
      title = user.locale === 'ru' ? 'Закрыть демо-счёт?' : 'Close demo account?';
      details = user.locale === 'ru'
        ? `Счёт: <b>${escapeHtml(accountLabel(account, 'ru'))}</b>\nБаланс: <b>${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'ru'))}</b>\nИстория останется, счёт можно восстановить.`
        : `Account: <b>${escapeHtml(accountLabel(account, 'en'))}</b>\nBalance: <b>${escapeHtml(formatMoney(balanceOf(state, account.id), account.currency, 'en'))}</b>\nHistory stays and the account can be restored.`;
      confirm = user.locale === 'ru' ? 'Закрыть счёт' : 'Close account';
    } else if (command.kind === 'restore_account' && account !== undefined) {
      title = user.locale === 'ru' ? 'Восстановить демо-счёт?' : 'Restore demo account?';
      details = user.locale === 'ru'
        ? `Счёт: <b>${escapeHtml(accountLabel(account, 'ru'))}</b>\nИстория и прежний баланс сохранятся.`
        : `Account: <b>${escapeHtml(accountLabel(account, 'en'))}</b>\nIts history and previous balance remain.`;
      confirm = user.locale === 'ru' ? 'Восстановить' : 'Restore';
    } else {
      return this.#sendExpired(chatId, user.locale, signal);
    }
    await this.#send(chatId, `<b>${title}</b>\n${details}\n\n${user.locale === 'ru' ? 'Это изменение только вымышленного демо.' : 'This only changes the fictional demo.'}`, {
      inline_keyboard: [[button(confirm, callback(reviewedSession.flowId, 'cf'))], [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(reviewedSession.flowId, 'bk'))]],
    }, signal);
  }

  #accountCommand(flowId: string, draft: AccountsDraft, locale: MoneyLocale): Extract<BankCommand, { kind: 'add_account' | 'adjust_balance' | 'close_account' | 'restore_account' }> | null {
    if (draft.pendingAction === 'add' && draft.currency !== undefined) {
      if (!/^f[0-9a-f]{11}$/.test(flowId)) return null;
      const decimalFlowId = BigInt(`0x${flowId}`).toString().padStart(15, '0');
      return {
        kind: 'add_account',
        accountId: `acc_bot_${flowId}`,
        currency: draft.currency,
        name: `Everyday ${draft.currency}`,
        number: `CM05${draft.currency}${decimalFlowId}`,
      };
    }
    if (draft.accountId === undefined) return null;
    if (draft.pendingAction === 'adjust' && draft.targetAmountInput !== undefined) {
      return { kind: 'adjust_balance', accountId: draft.accountId, targetAmountInput: draft.targetAmountInput, locale };
    }
    if (draft.pendingAction === 'close') return { kind: 'close_account', accountId: draft.accountId };
    if (draft.pendingAction === 'restore') return { kind: 'restore_account', accountId: draft.accountId };
    return null;
  }

  async #showRecurring(
    chatId: string,
    user: StoredUser,
    state: BankState,
    signal?: AbortSignal,
    flowId?: string,
    reviewChanged = false,
  ): Promise<void> {
    const rules = [...state.recurringRules].sort((left, right) => left.nextOccurrence.localeCompare(right.nextOccurrence));
    const session = this.#saveSession(user.telegramUserId, flowId ?? this.#flowId(), 'recurring', 'recurring_list', {
      kind: 'recurring',
      ruleIds: rules.map((rule) => rule.id),
    });
    const paused = rules.filter((rule) => rule.status === 'paused').length;
    const refreshNotice = reviewChanged
      ? user.locale === 'ru'
        ? '<b>Состояние изменилось</b>\nВыберите повторение ещё раз по актуальному списку.\n\n'
        : '<b>State changed</b>\nChoose the recurring entry again from the current list.\n\n'
      : '';
    const text = refreshNotice + (user.locale === 'ru'
      ? `<b>Повторения</b>\n${rules.length === 0 ? 'Пока пусто. Добавьте ежемесячную операцию через /add.' : `${rules.length} правил · ${paused} на паузе`}\n\nОперации появляются при открытии Cometa или обращении к боту.`
      : `<b>Recurring entries</b>\n${rules.length === 0 ? 'Nothing here yet. Create a monthly entry with /add.' : `${rules.length} rules · ${paused} paused`}\n\nEntries materialize when Cometa or the bot is opened.`);
    await this.#send(chatId, text, {
      inline_keyboard: [
        ...rules.map((rule, index) => [button(
          `${rule.status === 'paused' ? 'Ⅱ ' : ''}${rule.counterparty} · ${dateLabel(rule.nextOccurrence, user.locale)}`,
          callback(session.flowId, 'rl', String(index)),
        )]),
        [button(user.locale === 'ru' ? 'Записать расход' : 'Record expense', callback(session.flowId, 'te'))],
        [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(session.flowId, 'bk'))],
      ],
    }, signal);
  }

  async #handleRecurringCallback(
    chatId: string,
    user: StoredUser,
    updateId: number,
    session: ConversationSession,
    draft: RecurringDraft,
    parsed: ParsedCallback,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#availableState(user, chatId, signal);
    if (state === null) return;
    if (session.step === 'recurring_list' && parsed.action === 'te') {
      await this.#startTransaction(chatId, user, 'expense', signal, session.flowId);
      return;
    }
    if (session.step === 'recurring_list' && parsed.action === 'rl') {
      const index = indexArgument(parsed.argument, draft.ruleIds.length);
      const rule = index === null ? undefined : state.recurringRules.find((candidate) => candidate.id === draft.ruleIds[index]);
      if (rule === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const account = state.accounts.find((candidate) => candidate.id === rule.accountId);
      if (account === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#updateSession(session, 'recurring_detail', { ...draft, ruleId: rule.id });
      const status = rule.status === 'active'
        ? user.locale === 'ru' ? 'Активно' : 'Active'
        : pauseReasonText(rule.pauseReason, user.locale);
      const closedAccountHint = rule.pauseReason === 'account_closed'
        ? user.locale === 'ru'
          ? '\nВосстановите счёт: повторение включится автоматически.'
          : '\nRestore the account and this entry will resume automatically.'
        : '';
      const controls = rule.pauseReason === 'account_closed'
        ? [[button(user.locale === 'ru' ? 'К счетам' : 'Manage accounts', callback(updated.flowId, 'ma'))]]
        : [[button(
            rule.status === 'active'
              ? user.locale === 'ru' ? 'Приостановить' : 'Pause'
              : user.locale === 'ru' ? 'Возобновить' : 'Resume',
            callback(updated.flowId, rule.status === 'active' ? 'rp' : 'rr'),
          )]];
      await this.#send(chatId, (user.locale === 'ru'
        ? `<b>${escapeHtml(rule.counterparty)}</b>\n${directionLabel(rule.direction, 'ru')} · ${escapeHtml(formatMoney(rule.amountMinor, account.currency, 'ru'))}\nСчёт: ${escapeHtml(accountLabel(account, 'ru'))}\nСледующая дата: ${escapeHtml(dateLabel(rule.nextOccurrence, 'ru'))}\nСтатус: <b>${escapeHtml(status)}</b>${rule.note ? `\nКомментарий: ${escapeHtml(rule.note)}` : ''}`
        : `<b>${escapeHtml(rule.counterparty)}</b>\n${directionLabel(rule.direction, 'en')} · ${escapeHtml(formatMoney(rule.amountMinor, account.currency, 'en'))}\nAccount: ${escapeHtml(accountLabel(account, 'en'))}\nNext date: ${escapeHtml(dateLabel(rule.nextOccurrence, 'en'))}\nStatus: <b>${escapeHtml(status)}</b>${rule.note ? `\nNote: ${escapeHtml(rule.note)}` : ''}`) + closedAccountHint, {
        inline_keyboard: [...controls, [button(user.locale === 'ru' ? 'Назад' : 'Back', callback(updated.flowId, 'bk'))]],
      }, signal);
      return;
    }
    if (session.step === 'recurring_detail' && parsed.action === 'ma') {
      await this.#showAccounts(chatId, user, state, signal);
      return;
    }
    if (session.step === 'recurring_detail' && (parsed.action === 'rp' || parsed.action === 'rr') && draft.ruleId !== undefined) {
      const pendingAction = parsed.action === 'rp' ? 'pause' : 'resume';
      const command: BankCommand = { kind: pendingAction === 'pause' ? 'pause_recurring' : 'resume_recurring', ruleId: draft.ruleId };
      const reviewNowISO = this.#nowISO();
      const preview = applyBankCommand(state, command, { nowISO: reviewNowISO });
      if (!preview.ok) {
        await this.#send(chatId, this.#domainErrorText(preview.error, user.locale), undefined, signal);
        return;
      }
      const rule = state.recurringRules.find((candidate) => candidate.id === draft.ruleId);
      if (rule === undefined) return this.#sendExpired(chatId, user.locale, signal);
      const previewFingerprint = recurringReviewFingerprint(
        state,
        rule.id,
        reviewNowISO.slice(0, 10),
      );
      if (previewFingerprint === null) return this.#sendExpired(chatId, user.locale, signal);
      const updated = this.#replaceFlowSession(session, 'recurring_confirm', {
        ...draft,
        pendingAction,
        previewFingerprint,
      });
      await this.#send(chatId, user.locale === 'ru'
        ? `<b>${pendingAction === 'pause' ? 'Приостановить' : 'Возобновить'} повторение?</b>\n${escapeHtml(rule.counterparty)}\nИстория уже созданных операций не изменится.`
        : `<b>${pendingAction === 'pause' ? 'Pause' : 'Resume'} recurring entry?</b>\n${escapeHtml(rule.counterparty)}\nExisting history will not change.`, {
        inline_keyboard: [[button(user.locale === 'ru' ? 'Подтвердить' : 'Confirm', callback(updated.flowId, 'cf'))], [button(user.locale === 'ru' ? 'Отмена' : 'Cancel', callback(updated.flowId, 'bk'))]],
      }, signal);
      return;
    }
    if (session.step === 'recurring_confirm' && parsed.action === 'cf' && draft.ruleId !== undefined && draft.pendingAction !== undefined) {
      const command: BankCommand = {
        kind: draft.pendingAction === 'pause' ? 'pause_recurring' : 'resume_recurring',
        ruleId: draft.ruleId,
      };
      if (this.#isExactTelegramCommand(user.telegramUserId, updateId, command)) {
        await this.#execute(user, chatId, updateId, command, session, signal);
        return;
      }
      const confirmNowISO = this.#nowISO();
      if (
        draft.previewFingerprint !== recurringReviewFingerprint(
          state,
          draft.ruleId,
          confirmNowISO.slice(0, 10),
        )
      ) {
        await this.#showRecurring(chatId, user, state, signal, undefined, true);
        return;
      }
      const preview = applyBankCommand(state, command, { nowISO: confirmNowISO });
      if (!preview.ok) {
        const retrySession = this.#replaceFlowSession(session, 'recurring_confirm', draft);
        await this.#send(chatId, this.#domainErrorText(preview.error, user.locale), {
          inline_keyboard: [[button(
            user.locale === 'ru' ? 'На главную' : 'Dashboard',
            callback(retrySession.flowId, 'bk'),
          )]],
        }, signal);
        return;
      }
      await this.#execute(user, chatId, updateId, command, session, signal);
      return;
    }
    await this.#sendExpired(chatId, user.locale, signal);
  }

  async #execute(
    user: StoredUser,
    chatId: string,
    updateId: number,
    command: BankCommand,
    session: ConversationSession | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const replayFingerprint = canonicalJsonDigest({ version: 1, command });
    const retryAfterSeconds = this.#mutationLimiter.consume({
      telegramUserId: user.telegramUserId,
      kind: 'command',
      sourceKind: 'telegram',
      operationId: String(updateId),
      replayFingerprint,
      durableReplay: this.#repository.isExactBankOperation(
        user.telegramUserId,
        'telegram',
        String(updateId),
        replayFingerprint,
      ),
      nowMs: this.#clock().getTime(),
    });
    if (retryAfterSeconds !== null) {
      const text = user.locale === 'ru'
        ? `<b>Слишком много изменений подряд</b>\nПодождите ${retryAfterSeconds} сек. и подтвердите ещё раз.`
        : `<b>Too many changes at once</b>\nWait ${retryAfterSeconds} sec and confirm again.`;
      await this.#send(chatId, text, undefined, signal);
      return false;
    }
    const deliveryContext = this.#deliveryContext(user.telegramUserId, command);
    try {
      this.#service.executeCommand({
        telegramUserId: user.telegramUserId,
        sourceKind: 'telegram',
        operationId: String(updateId),
        rawCommand: command,
        chatId,
        ...(deliveryContext === undefined ? {} : { deliveryContext }),
      });
      if (session !== undefined) this.#repository.deleteConversationSession(user.telegramUserId, session.flowId);
    } catch (error: unknown) {
      if (!(error instanceof BankServiceError)) throw error;
      if (error.code === 'bank_import_required' || error.code === 'bank_authority_disabled') {
        this.reset(user.telegramUserId);
        await this.#sendActivation(chatId, user.locale, error.code === 'bank_import_required', signal);
        return false;
      }
      const pending = COMMITTED_DOMAIN_FAILURES.has(error.code) &&
        this.#repository.hasBankOutboxForOperation(
          user.telegramUserId,
          'telegram',
          String(updateId),
        );
      if (!pending) {
        await this.#send(
          chatId,
          this.#serviceErrorText(error, user.locale, deliveryContext?.currency),
          undefined,
          signal,
        );
        return false;
      }
    }
    await this.flushBankOutbox(signal);
    return true;
  }

  #isExactTelegramCommand(
    telegramUserId: string,
    updateId: number,
    command: BankCommand,
  ): boolean {
    return this.#repository.isExactBankOperation(
      telegramUserId,
      'telegram',
      String(updateId),
      canonicalJsonDigest({ version: 1, command }),
    );
  }

  async #deliverBankOutbox(item: BankOutboxItem, signal?: AbortSignal): Promise<void> {
    const user = this.#repository.getUser(item.telegramUserId);
    if (user === null) throw new Error('Bank outbox user not found');
    let text: string;
    if (item.messageKind === 'bank_materialization_warning') {
      const payload = parseWarningOutboxPayload(item.payload);
      if (payload === null) throw new Error('Invalid bank warning outbox payload');
      const heading = user.locale === 'ru'
        ? '<b>Повторение было приостановлено</b>'
        : '<b>Recurring entry was paused</b>';
      text = `${heading}${this.#warningLines(
        payload.warnings,
        payload.warningContexts,
        user.locale,
      )}`;
    } else {
      const payload = parseOutboxPayload(item.payload);
      if (item.messageKind !== 'bank_operation_result' || payload === null) {
        throw new Error('Invalid bank outbox payload');
      }
      if (payload.failure !== undefined) {
        text = this.#domainErrorText(
          payload.failure.code,
          user.locale,
          payload.deliveryContext?.currency,
          payload.failure.availableMinor,
          payload.failure.requiredMinor,
        );
      } else {
        text = operationSuccessText(payload.operationKind, payload.applied, user.locale);
      }
      text += this.#warningLines(
        payload.warnings,
        payload.warningContexts,
        user.locale,
      );
    }
    await this.#send(item.chatId, text, {
      inline_keyboard: [[webAppButton(user.locale === 'ru' ? 'Открыть Cometa' : 'Open Cometa', this.#webAppUrl)]],
    }, signal);
    if (!this.#repository.completeBankOutbox(item.id)) {
      throw new Error('Bank outbox disappeared before completion');
    }
  }

  #warningLines(
    warnings: readonly unknown[],
    contexts: readonly RecurringWarningDeliveryContext[] | undefined,
    locale: BotLocale,
  ): string {
    if (contexts !== undefined) {
      return contexts.map((context) => {
        const name = escapeHtml(context.counterparty);
        if (
          context.reason === 'insufficient_funds' &&
          context.availableMinor !== undefined &&
          context.requiredMinor !== undefined
        ) {
          return locale === 'ru'
            ? `\nБыло приостановлено: <b>${name}</b> · на тот момент было доступно ${escapeHtml(formatMoney(context.availableMinor, context.currency, 'ru'))}, требовалось ${escapeHtml(formatMoney(context.requiredMinor, context.currency, 'ru'))}`
            : `\nWas paused: <b>${name}</b> · at that time ${escapeHtml(formatMoney(context.availableMinor, context.currency, 'en'))} was available and ${escapeHtml(formatMoney(context.requiredMinor, context.currency, 'en'))} was required`;
        }
        const detail = locale === 'ru'
          ? context.reason === 'capacity'
            ? 'на тот момент был достигнут лимит истории'
            : 'сумма вышла за безопасный предел'
          : context.reason === 'capacity'
            ? 'the history limit had been reached'
            : 'the amount exceeded the safe limit at that time';
        return `\n${locale === 'ru' ? 'Было приостановлено' : 'Was paused'}: <b>${name}</b> · ${detail}`;
      }).join('');
    }

    const lines: string[] = [];
    for (const warning of warnings) {
      if (
        !isObject(warning) ||
        typeof warning.ruleId !== 'string' ||
        (warning.reason !== 'capacity' &&
          warning.reason !== 'overflow' &&
          warning.reason !== 'insufficient_funds')
      ) continue;
      const detail = locale === 'ru'
        ? warning.reason === 'capacity'
          ? 'Повторение было приостановлено: на тот момент был достигнут лимит истории.'
          : warning.reason === 'overflow'
            ? 'Повторение было приостановлено: сумма вышла за безопасный предел.'
            : 'Повторение было приостановлено: на тот момент на счёте не хватило средств.'
        : warning.reason === 'capacity'
          ? 'A recurring entry was paused because the history limit had been reached.'
          : warning.reason === 'overflow'
            ? 'A recurring entry was paused because the amount exceeded the safe limit.'
            : 'A recurring entry was paused because the account lacked funds at that time.';
      lines.push(`\n${detail}`);
    }
    return lines.join('');
  }

  #domainErrorText(
    code: string,
    locale: BotLocale,
    currency?: Currency,
    availableMinor?: number,
    requiredMinor?: number,
  ): string {
    if (
      code === 'insufficient_funds' &&
      currency !== undefined &&
      Number.isSafeInteger(availableMinor) &&
      Number.isSafeInteger(requiredMinor)
    ) {
      return locale === 'ru'
        ? `<b>Счёт уйдёт в минус</b>\nДоступно: ${escapeHtml(formatMoney(availableMinor as number, currency, 'ru'))}\nНужно: ${escapeHtml(formatMoney(requiredMinor as number, currency, 'ru'))}\nУменьшите сумму и подтвердите заново.`
        : `<b>This would overdraw the account</b>\nAvailable: ${escapeHtml(formatMoney(availableMinor as number, currency, 'en'))}\nRequired: ${escapeHtml(formatMoney(requiredMinor as number, currency, 'en'))}\nLower the amount and review it again.`;
    }
    const copy: Readonly<Record<string, readonly [string, string]>> = {
      invalid_amount: ['Проверьте формат суммы.', 'Check the amount format.'],
      amount_too_large: ['Одна операция не может превышать эквивалент 100 000 USD.', 'One operation cannot exceed the equivalent of USD 100,000.'],
      invalid_date: ['Проверьте дату по UTC.', 'Check the UTC date.'],
      invalid_counterparty: ['Проверьте название получателя или отправителя.', 'Check the recipient or sender name.'],
      invalid_note: ['Проверьте комментарий.', 'Check the note.'],
      checking_only: ['Операции доступны только на текущих счетах.', 'Transactions are available only for checking accounts.'],
      account_closed: ['Счёт закрыт. Восстановите его через /accounts.', 'The account is closed. Restore it with /accounts.'],
      duplicate_currency: ['Активный текущий счёт в этой валюте уже есть. Закрытый можно восстановить.', 'An active checking account already uses this currency. A closed one can be restored.'],
      non_zero_balance: ['Сначала скорректируйте баланс счёта до нуля.', 'Adjust the account balance to zero first.'],
      last_active_account: ['Нельзя закрыть последний активный счёт.', 'The last active account cannot be closed.'],
      too_many_occurrences: ['Период длиннее лимита в 120 месяцев. Выберите более поздний старт.', 'The period exceeds 120 months. Choose a later start.'],
      capacity: ['Демо достигло лимита истории. Управление счетами и повторениями остаётся доступным.', 'The demo history limit was reached. Account and recurring controls remain available.'],
      operation_capacity: ['Очередь подтверждений заполнена. Подождите их отправки и повторите.', 'The confirmation queue is full. Wait for delivery, then try again.'],
      bank_state_too_large: ['Демо достигло лимита размера. Сбросьте его в Mini App и повторите.', 'The demo reached its size limit. Reset it in the Mini App, then try again.'],
      balance_overflow: ['Сумма вышла за безопасный предел.', 'The amount exceeded the safe limit.'],
      duplicate_account: ['Такой демо-счёт уже существует.', 'That demo account already exists.'],
      unknown_account: ['Счёт больше не доступен. Откройте /accounts заново.', 'That account is no longer available. Open /accounts again.'],
      unknown_rule: ['Повторение больше не доступно. Откройте /recurring заново.', 'That recurring entry is no longer available. Open /recurring again.'],
    };
    const value = copy[code] ?? ['Не удалось сохранить изменение. Начните заново.', 'The change could not be saved. Start again.'];
    return `<b>${locale === 'ru' ? 'Не сохранено' : 'Not saved'}</b>\n${locale === 'ru' ? value[0] : value[1]}`;
  }

  #serviceErrorText(error: BankServiceError, locale: BotLocale, currency?: Currency): string {
    return this.#domainErrorText(
      error.code,
      locale,
      currency,
      typeof error.details?.availableMinor === 'number' ? error.details.availableMinor : undefined,
      typeof error.details?.requiredMinor === 'number' ? error.details.requiredMinor : undefined,
    );
  }

  async #availableState(user: StoredUser, chatId: string, signal?: AbortSignal): Promise<BankState | null> {
    const payload = this.#service.bootstrap(user.telegramUserId);
    if (payload === null || payload.mode === 'import_required') {
      await this.#sendActivation(chatId, user.locale, payload?.mode === 'import_required', signal);
      return null;
    }
    return this.#stateFrom(payload);
  }

  #storedState(telegramUserId: string): BankState | null {
    const stored = this.#repository.getBankState(telegramUserId);
    if (stored === null) return null;
    return parseBankState(stored.state, this.#nowISO(), { expectedTelegramId: telegramUserId });
  }

  #deliveryContext(telegramUserId: string, command: BankCommand): BankDeliveryContext | undefined {
    const state = this.#storedState(telegramUserId);
    let accountId: string | undefined;
    let currency: Currency | undefined;
    switch (command.kind) {
      case 'record_transaction':
      case 'create_recurring':
      case 'adjust_balance':
      case 'close_account':
      case 'restore_account':
        accountId = command.accountId;
        break;
      case 'add_account':
        accountId = command.accountId;
        currency = command.currency;
        break;
      case 'transfer':
        accountId = command.request.fromAccountId;
        break;
      case 'pause_recurring':
      case 'resume_recurring':
        accountId = state?.recurringRules.find((rule) => rule.id === command.ruleId)?.accountId;
        break;
      case 'set_card_frozen':
        accountId = state?.cards.find((card) => card.id === command.cardId)?.accountId;
        break;
      default:
        break;
    }
    if (accountId === undefined) return undefined;
    currency ??= state?.accounts.find((account) => account.id === accountId)?.currency;
    return { accountId, ...(currency === undefined ? {} : { currency }) };
  }

  #stateFrom(payload: ServerBankPayload): BankState {
    const state = parseBankState(payload.state, this.#nowISO(), { expectedTelegramId: payload.telegramId });
    if (state === null) throw new Error('Bank service returned an invalid canonical state');
    return state;
  }

  #newSession(
    telegramUserId: string,
    flowKind: FlowKind,
    step: string,
    draft: FlowDraft,
  ): ConversationSession {
    return this.#saveSession(telegramUserId, this.#flowId(), flowKind, step, draft);
  }

  #saveSession(
    telegramUserId: string,
    flowId: string,
    flowKind: FlowKind,
    step: string,
    draft: FlowDraft,
  ): ConversationSession {
    if (!FLOW_ID_PATTERN.test(flowId)) throw new TypeError('Invalid bank flow ID');
    const now = this.#clock();
    const session = {
      telegramUserId,
      flowId,
      flowKind,
      step,
      draft,
      expiresAt: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
    } as const;
    const context = this.#wizardUpdate.getStore();
    if (context !== undefined) {
      if (context.telegramUserId !== telegramUserId) {
        throw new Error('Wizard update crossed Telegram users');
      }
      context.pendingSession = session;
      return { ...session, updatedAt: now.toISOString() };
    }
    return this.#repository.upsertConversationSession(session);
  }

  #updateSession(session: ConversationSession, step: string, draft: FlowDraft): ConversationSession {
    return this.#saveSession(session.telegramUserId, session.flowId, session.flowKind, step, draft);
  }

  #replaceFlowSession(
    session: ConversationSession,
    step: string,
    draft: FlowDraft,
  ): ConversationSession {
    return this.#saveSession(
      session.telegramUserId,
      this.#flowId(),
      session.flowKind,
      step,
      draft,
    );
  }

  #flowId(): string {
    return `f${randomBytes(6).toString('hex').slice(0, 11)}`;
  }

  #nowISO(): string {
    const now = this.#clock();
    if (!Number.isSafeInteger(now.getTime())) throw new Error('Invalid bank flow clock');
    return now.toISOString();
  }

  async #withWizardUpdate<T>(
    sourceUpdateId: number,
    telegramUserId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const active = this.#wizardUpdate.getStore();
    if (active !== undefined) {
      if (
        active.sourceUpdateId !== sourceUpdateId ||
        active.telegramUserId !== telegramUserId
      ) {
        throw new Error('Nested wizard update context mismatch');
      }
      return await action();
    }
    const context: WizardUpdateContext = { sourceUpdateId, telegramUserId };
    return await this.#wizardUpdate.run(context, async () => {
      const result = await action();
      if (context.pendingSession !== undefined) {
        throw new Error('Wizard session transition did not queue a reply');
      }
      return result;
    });
  }

  async #attemptConversationReply(
    reply: ConversationReply,
    signal?: AbortSignal,
  ): Promise<void> {
    if (reply.status === 'delivered') return;
    try {
      signal?.throwIfAborted();
      await this.#transport.sendMessage({
        chatId: reply.chatId,
        text: reply.text,
        replyMarkup: parseConversationReplyMarkup(reply.replyMarkup),
      }, signal);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (!isPermanentSendError(error)) throw error;
      this.reset(reply.telegramUserId);
      if (!this.#repository.deleteConversationReply(reply.sourceUpdateId)) {
        throw new Error('Conversation reply disappeared before rejection cleanup', { cause: error });
      }
      this.#logger.warn('telegram_conversation_reply_rejected', {
        sourceUpdateId: reply.sourceUpdateId,
      });
      return;
    }
    if (!this.#repository.markConversationReplyDelivered(reply.sourceUpdateId)) {
      throw new Error('Conversation reply disappeared before delivery completion');
    }
  }

  async #sendActivation(
    chatId: string,
    locale: BotLocale,
    importRequired: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const text = locale === 'ru'
      ? `<b>${importRequired ? 'Откройте Cometa один раз' : 'Банковские команды скоро включатся'}</b>\n${importRequired ? 'Mini App безопасно импортирует текущую демо-копию этого устройства и сделает её основной для вашего Telegram ID. Бот сам не создаёт и не заменяет счета.' : 'Пока демо работает локально. Откройте Mini App; ваши данные не будут перенесены без подтверждённого запуска.'}`
      : `<b>${importRequired ? 'Open Cometa once' : 'Bank commands are almost ready'}</b>\n${importRequired ? 'The Mini App will safely import this device’s current demo and make it canonical for your Telegram ID. The bot never creates or replaces accounts itself.' : 'The demo is still device-local. Open the Mini App; nothing is moved without a verified launch.'}`;
    await this.#send(chatId, text, {
      inline_keyboard: [[webAppButton(locale === 'ru' ? 'Открыть Cometa' : 'Open Cometa', this.#webAppUrl)]],
    }, signal);
  }

  async #sendExpired(chatId: string, locale: BotLocale, signal?: AbortSignal): Promise<void> {
    await this.#send(chatId, locale === 'ru'
      ? 'Этот шаг уже устарел. Начните заново: /add, /accounts или /recurring.'
      : 'This step has expired. Start again with /add, /accounts, or /recurring.', undefined, signal);
  }

  async #send(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const context = this.#wizardUpdate.getStore();
    if (context?.pendingSession !== undefined) {
      const reply = this.#repository.upsertConversationSessionWithReply({
        sourceUpdateId: context.sourceUpdateId,
        chatId,
        text,
        ...(replyMarkup === undefined ? {} : { replyMarkup }),
        session: context.pendingSession,
      });
      context.pendingSession = undefined;
      await this.#attemptConversationReply(reply, signal);
      return;
    }
    await this.#transport.sendMessage({ chatId, text, replyMarkup }, signal);
  }

  async #answer(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      await this.#transport.answerCallbackQuery(callbackQueryId, text, signal);
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (isFatalSendError(error)) throw error;
      this.#logger.warn('telegram_callback_answer_failed');
    }
  }
}
