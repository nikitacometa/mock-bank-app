import { ledgerErrors } from '@/domain/invariants';
import { applySettleAll, epochDayUTC } from '@/domain/interest';
import {
  SUPPORTED_CURRENCIES,
  convertMoneyAtBaseRates,
  quoteCrossRate,
} from '@/domain/currency';
import { isTelegramMiniApp } from '@/platform/environment';
import { isRateSnapshotDateCoherent } from '@/services/exchangeRates';
import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '@/i18n/catalog';
import { isClientTransferId } from '@/domain/transfer';
import type {
  Account,
  BankState,
  Card,
  Contact,
  Currency,
  ExchangeRateSnapshot,
  Profile,
  Transaction,
  TransactionFxSnapshot,
} from '@/domain/types';

/**
 * The ONLY file that touches localStorage (enforced by eslint.config.js).
 * Backing store swaps (Telegram CloudStorage, backend) happen here alone.
 */
const WEB_NAMESPACE_ROOT = 'cometa.bank';
const LEGACY_TELEGRAM_NAMESPACE_ROOT = 'cometa.bank.tma';
const TELEGRAM_USER_NAMESPACE_PREFIX = 'cometa.bank.tma.user.';
const TELEGRAM_QUARANTINE_NAMESPACE_ROOT = 'cometa.bank.tma.quarantine';
const TELEGRAM_RUNTIME = isTelegramMiniApp();
const LAUNCH_PREFERENCES_LOCK = TELEGRAM_RUNTIME
  ? `${LEGACY_TELEGRAM_NAMESPACE_ROOT}.launch-preferences`
  : `${WEB_NAMESPACE_ROOT}.launch-preferences`;
const LAUNCH_PREFERENCES_RECEIPT_VERSION = 2;
export const SCHEMA_VERSION = 4;

interface PersistenceNamespace {
  readonly root: string;
  readonly telegramId?: string;
  readonly persistent: boolean;
}

interface PersistenceKeys {
  readonly bank: string | null;
  readonly locale: string | null;
  readonly mutationLock: string;
  readonly launchPreferencesReceipt: string | null;
}

const WEB_NAMESPACE: PersistenceNamespace = {
  root: WEB_NAMESPACE_ROOT,
  persistent: true,
};
const TELEGRAM_QUARANTINE_NAMESPACE: PersistenceNamespace = {
  root: TELEGRAM_QUARANTINE_NAMESPACE_ROOT,
  persistent: false,
};
let activeNamespace = TELEGRAM_RUNTIME ? TELEGRAM_QUARANTINE_NAMESPACE : WEB_NAMESPACE;

function isCanonicalTelegramId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

function telegramUserNamespace(telegramId: string): PersistenceNamespace {
  return {
    root: `${TELEGRAM_USER_NAMESPACE_PREFIX}${telegramId}`,
    telegramId,
    persistent: true,
  };
}

function keysFor(namespace: PersistenceNamespace = activeNamespace): PersistenceKeys {
  return {
    bank: namespace.persistent ? namespace.root : null,
    locale: namespace.persistent ? `${namespace.root}.locale` : null,
    mutationLock: `${namespace.root}.mutation`,
    launchPreferencesReceipt: namespace.persistent
      ? `${namespace.root}.launch-preferences-receipt`
      : null,
  };
}

export function isTelegramPersistenceRuntime(): boolean {
  return TELEGRAM_RUNTIME;
}

/** Stable token used only to bind in-memory write-authority to the active namespace. */
export function getActivePersistenceScope(): string {
  return activeNamespace.root;
}

export function getActiveTelegramPersistenceId(): string | undefined {
  return activeNamespace.telegramId;
}

/** Unknown or malformed Telegram identity always returns to an ephemeral safe namespace. */
export function quarantineTelegramPersistence(): void {
  if (TELEGRAM_RUNTIME) activeNamespace = TELEGRAM_QUARANTINE_NAMESPACE;
}

/** Switch only after the backend has HMAC-validated initData and returned this canonical ID. */
export function activateTelegramPersistence(telegramId: unknown): boolean {
  if (!TELEGRAM_RUNTIME || !isCanonicalTelegramId(telegramId)) {
    quarantineTelegramPersistence();
    return false;
  }
  // Preserve the scope token for a repeated bootstrap of the same account.
  // Otherwise an already-waiting mutation would abort merely because the
  // verified preferences retry reactivated an equivalent namespace.
  if (activeNamespace.telegramId !== telegramId) {
    activeNamespace = telegramUserNamespace(telegramId);
  }
  migrateLegacyTelegramNamespace(telegramId);
  return true;
}

export interface AppliedLaunchPreferencesReceipt {
  readonly version: typeof LAUNCH_PREFERENCES_RECEIPT_VERSION;
  readonly bankSchemaVersion: typeof SCHEMA_VERSION;
  readonly telegramId: string;
  /** Stable for one server-side preferences database generation. */
  readonly revisionEpoch: string;
  readonly revision: number;
}

type UnknownRecord = Record<string, unknown>;

const ACCOUNT_TYPES = ['checking', 'savings'] as const;
const TRANSACTION_KINDS = [
  'purchase',
  'transfer_own_out',
  'transfer_own_in',
  'transfer_contact',
  'interest',
  'topup',
  'seed',
] as const;
const TRANSACTION_STATUSES = ['posted', 'pending'] as const;
const CARD_BRANDS = ['visa', 'mastercard'] as const;
const CARD_DESIGNS = ['midnight', 'ivory', 'mint'] as const;
const CARD_STATUSES = ['active', 'frozen'] as const;
const EXCHANGE_RATE_SOURCES = ['frankfurter', 'fallback'] as const;
const RECENT_TRANSFER_IDS_CAP = 50;
const MAX_PROFILE_DISPLAY_NAME_CODE_POINTS = 48;
const DISALLOWED_PROFILE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const PROFILE_SEPARATORS = /\p{Z}+/gu;
/** APY is a fraction (1 = 100%); persisted state is untrusted, so reject absurd exponents. */
const MAX_ACCOUNT_APY = 1;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function isOptional<T>(value: unknown, guard: (item: unknown) => item is T): value is T | undefined {
  return value === undefined || guard(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isCurrency(value: unknown): value is Currency {
  return isOneOf(value, SUPPORTED_CURRENCIES);
}

function isPositiveDecimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    BigInt(value.replace('.', '')) > 0n
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

/** Accept ISO-8601 instants with a timezone, while rejecting date-only and normalised junk dates. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function isAccrualAnchor(value: unknown, createdAt: string): value is string {
  return isIsoTimestamp(value) && epochDayUTC(value) >= epochDayUTC(createdAt);
}

function isAccount(value: unknown): value is Account {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isOneOf(value.type, ACCOUNT_TYPES) ||
    !isNonEmptyString(value.name) ||
    !isCurrency(value.currency) ||
    !isNonEmptyString(value.number) ||
    !isIsoTimestamp(value.createdAt)
  ) {
    return false;
  }

  const validApy =
    value.apy === undefined ||
    (typeof value.apy === 'number' &&
      Number.isFinite(value.apy) &&
      value.apy >= 0 &&
      value.apy <= MAX_ACCOUNT_APY);
  const validAnchor =
    value.accrualAnchor === undefined || isAccrualAnchor(value.accrualAnchor, value.createdAt);
  const savingsFieldsMatchType =
    value.type === 'savings'
      ? value.apy !== undefined && value.accrualAnchor !== undefined
      : value.apy === undefined && value.accrualAnchor === undefined;
  return validApy && validAnchor && savingsFieldsMatchType;
}

function isExchangeRateSnapshot(value: unknown): value is ExchangeRateSnapshot {
  if (
    !isRecord(value) ||
    value.base !== 'USD' ||
    !isIsoDate(value.asOf) ||
    !isIsoTimestamp(value.fetchedAt) ||
    !isOneOf(value.source, EXCHANGE_RATE_SOURCES) ||
    !isRecord(value.rates)
  ) {
    return false;
  }
  const rates = value.rates;
  const keys = Object.keys(rates);
  return (
    keys.length === SUPPORTED_CURRENCIES.length &&
    SUPPORTED_CURRENCIES.every((currency) => isPositiveDecimal(rates[currency])) &&
    rates.USD === '1' &&
    isRateSnapshotDateCoherent(value.asOf, value.fetchedAt)
  );
}

function isFxSnapshot(value: unknown): value is TransactionFxSnapshot {
  if (
    !isRecord(value) ||
    !(
    isCurrency(value.fromCurrency) &&
    isCurrency(value.toCurrency) &&
    value.fromCurrency !== value.toCurrency &&
    isSafeInteger(value.fromAmountMinor) &&
    value.fromAmountMinor > 0 &&
    isSafeInteger(value.toAmountMinor) &&
    value.toAmountMinor > 0 &&
    isPositiveDecimal(value.rate) &&
    isPositiveDecimal(value.fromUsdRate) &&
    isPositiveDecimal(value.toUsdRate) &&
    isIsoDate(value.asOf) &&
    isIsoTimestamp(value.fetchedAt) &&
    isOneOf(value.source, EXCHANGE_RATE_SOURCES)
    )
  ) {
    return false;
  }
  if (
    (value.fromCurrency === 'USD' && value.fromUsdRate !== '1') ||
    (value.toCurrency === 'USD' && value.toUsdRate !== '1') ||
    !isRateSnapshotDateCoherent(value.asOf, value.fetchedAt)
  ) {
    return false;
  }
  try {
    return (
      value.rate ===
        quoteCrossRate(
          value.fromCurrency,
          value.toCurrency,
          value.fromUsdRate,
          value.toUsdRate,
        ) &&
      convertMoneyAtBaseRates(
        value.fromAmountMinor,
        value.fromCurrency,
        value.toCurrency,
        value.fromUsdRate,
        value.toUsdRate,
      ) === value.toAmountMinor
    );
  } catch {
    return false;
  }
}

function isTransaction(value: unknown): value is Transaction {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.accountId) &&
    isSafeInteger(value.seq) &&
    value.seq > 0 &&
    isSafeInteger(value.amountMinor) &&
    isSafeInteger(value.balanceAfterMinor) &&
    isOneOf(value.kind, TRANSACTION_KINDS) &&
    isOptional(value.status, (status): status is Transaction['status'] & string =>
      isOneOf(status, TRANSACTION_STATUSES),
    ) &&
    isOptional(value.counterparty, isNonEmptyString) &&
    isOptional(value.category, isNonEmptyString) &&
    isOptional(value.transferGroupId, isNonEmptyString) &&
    isOptional(value.fxSnapshot, isFxSnapshot) &&
    isIsoTimestamp(value.createdAt)
  );
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.accountId) &&
    isOneOf(value.brand, CARD_BRANDS) &&
    typeof value.last4 === 'string' &&
    /^\d{4}$/.test(value.last4) &&
    isNonEmptyString(value.holder) &&
    typeof value.expiry === 'string' &&
    /^(0[1-9]|1[0-2])\/\d{2}$/.test(value.expiry) &&
    isOneOf(value.design, CARD_DESIGNS) &&
    isOneOf(value.status, CARD_STATUSES)
  );
}

function isContact(value: unknown): value is Contact {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.initials) &&
    isOptional(value.lastTransferAt, isIsoTimestamp)
  );
}

function isProfile(value: unknown): value is Profile {
  if (!isRecord(value)) return false;
  const displayName = value.displayName;
  const canonicalDisplayName = typeof displayName === 'string'
    ? displayName.normalize('NFC').replace(PROFILE_SEPARATORS, ' ').trim()
    : null;
  return (
    typeof displayName === 'string' &&
    displayName === canonicalDisplayName &&
    displayName.length > 0 &&
    [...displayName].length <= MAX_PROFILE_DISPLAY_NAME_CODE_POINTS &&
    !DISALLOWED_PROFILE_CHARACTERS.test(displayName) &&
    isOptional(
      value.telegramId,
      (telegramId): telegramId is string =>
        typeof telegramId === 'string' && /^[1-9]\d{0,19}$/.test(telegramId),
    )
  );
}

function hasUniqueIds<T extends { id: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function hasValidTransferGroups(transactions: Transaction[], accounts: Account[]): boolean {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const isOwnTransfer =
      transaction.kind === 'transfer_own_out' || transaction.kind === 'transfer_own_in';
    if (isOwnTransfer !== (transaction.transferGroupId !== undefined)) return false;
    if (!isOwnTransfer && transaction.fxSnapshot !== undefined) return false;
    if (transaction.transferGroupId === undefined) continue;
    const group = groups.get(transaction.transferGroupId) ?? [];
    group.push(transaction);
    groups.set(transaction.transferGroupId, group);
  }

  for (const [groupId, group] of groups) {
    if (group.length !== 2) return false;
    const outgoing = group.find((transaction) => transaction.kind === 'transfer_own_out');
    const incoming = group.find((transaction) => transaction.kind === 'transfer_own_in');
    if (
      outgoing === undefined ||
      incoming === undefined ||
      outgoing.accountId === incoming.accountId ||
      outgoing.amountMinor >= 0 ||
      incoming.amountMinor <= 0
    ) {
      return false;
    }
    if (
      incoming.seq !== outgoing.seq + 1 ||
      incoming.createdAt !== outgoing.createdAt ||
      (/^grp_\d+$/.test(groupId) && groupId !== `grp_${outgoing.seq}`)
    ) {
      return false;
    }
    const fromAccount = accountById.get(outgoing.accountId);
    const toAccount = accountById.get(incoming.accountId);
    if (!fromAccount || !toAccount) return false;
    const fromFx = outgoing.fxSnapshot;
    const toFx = incoming.fxSnapshot;
    if (fromAccount.currency === toAccount.currency) {
      if (fromFx !== undefined || toFx !== undefined || -outgoing.amountMinor !== incoming.amountMinor) {
        return false;
      }
    } else {
      if (
        fromFx === undefined ||
        toFx === undefined ||
        JSON.stringify(fromFx) !== JSON.stringify(toFx) ||
        fromFx.fromCurrency !== fromAccount.currency ||
        fromFx.toCurrency !== toAccount.currency ||
        fromFx.fromAmountMinor !== -outgoing.amountMinor ||
        fromFx.toAmountMinor !== incoming.amountMinor
      ) {
        return false;
      }
    }
  }
  return true;
}

function canSettleAtLoadBoundary(state: BankState, nowISO: string): boolean {
  try {
    applySettleAll(state, nowISO);
    return true;
  } catch {
    return false;
  }
}

/** Runtime boundary: validate untrusted JSON and return only known BankState fields. */
function parseBankState(s: unknown, nowISO: string): BankState | null {
  if (!isRecord(s)) return null;
  if (
    !isCurrency(s.primaryCurrency) ||
    !isExchangeRateSnapshot(s.exchangeRates) ||
    !isArrayOf(s.accounts, isAccount) ||
    s.accounts.length === 0 ||
    !isArrayOf(s.transactions, isTransaction) ||
    !isArrayOf(s.cards, isCard) ||
    !isArrayOf(s.contacts, isContact) ||
    !isProfile(s.profile) ||
    !isSafeInteger(s.nextSeq) ||
    s.nextSeq <= 0 ||
    !isArrayOf(s.recentTransferIds, isClientTransferId) ||
    s.recentTransferIds.length > RECENT_TRANSFER_IDS_CAP
  ) {
    return null;
  }

  const candidate: BankState = {
    primaryCurrency: s.primaryCurrency,
    exchangeRates: s.exchangeRates,
    accounts: s.accounts,
    transactions: s.transactions,
    cards: s.cards,
    contacts: s.contacts,
    profile: s.profile,
    nextSeq: s.nextSeq,
    recentTransferIds: s.recentTransferIds,
  };
  const accountIds = new Set(candidate.accounts.map((account) => account.id));
  const lastSeq = candidate.transactions.at(-1)?.seq ?? 0;

  const isValid =
    hasUniqueIds(candidate.accounts) &&
    hasUniqueIds(candidate.transactions) &&
    hasUniqueIds(candidate.cards) &&
    hasUniqueIds(candidate.contacts) &&
    new Set(candidate.recentTransferIds).size === candidate.recentTransferIds.length &&
    candidate.transactions.every(
      (transaction) =>
        transaction.id === `tx_${transaction.seq}` && accountIds.has(transaction.accountId),
    ) &&
    candidate.cards.every((card) => accountIds.has(card.accountId)) &&
    candidate.nextSeq === lastSeq + 1 &&
    hasValidTransferGroups(candidate.transactions, candidate.accounts) &&
    ledgerErrors(candidate).length === 0 &&
    canSettleAtLoadBoundary(candidate, nowISO);
  return isValid ? candidate : null;
}

export type LoadResult =
  | { kind: 'ok'; state: BankState }
  | { kind: 'empty' }
  | { kind: 'corrupted' };

function loadPersistedFromKey(
  key: string,
  expectedTelegramId?: string,
): LoadResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { kind: 'empty' }; // storage unavailable (private mode) — run in-memory
  }
  if (raw === null) return { kind: 'empty' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { kind: 'corrupted' };
    if (parsed.schemaVersion !== SCHEMA_VERSION) return { kind: 'corrupted' };
    const state = parseBankState(parsed.state, new Date().toISOString());
    if (state === null) return { kind: 'corrupted' };
    if (
      expectedTelegramId !== undefined &&
      state.profile.telegramId !== expectedTelegramId
    ) {
      return { kind: 'corrupted' };
    }
    return { kind: 'ok', state };
  } catch {
    return { kind: 'corrupted' };
  }
}

export function loadPersisted(): LoadResult {
  const key = keysFor().bank;
  if (key === null) return { kind: 'empty' };
  return loadPersistedFromKey(key, activeNamespace.telegramId);
}

export function savePersisted(state: BankState): boolean {
  const key = keysFor().bank;
  if (key === null) return true;
  if (
    activeNamespace.telegramId !== undefined &&
    state.profile.telegramId !== activeNamespace.telegramId
  ) {
    return false;
  }
  try {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }));
    return true;
  } catch {
    // The store treats a failed write as an explicit in-memory-authoritative mode.
    // Returning false is essential: reading an older valid snapshot on the next
    // mutation would otherwise silently revert the mutation that just succeeded.
    return false;
  }
}

/** UI preference kept outside BankState so resetting demo data preserves it. */
export function loadLocalePreference(): AppLocale {
  const key = keysFor().locale;
  if (key === null) return DEFAULT_LOCALE;
  try {
    const stored = localStorage.getItem(key);
    return isAppLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function saveLocalePreference(locale: AppLocale): boolean {
  const key = keysFor().locale;
  if (key === null) return true;
  try {
    localStorage.setItem(key, locale);
    return true;
  } catch {
    return false;
  }
}

function parseLaunchPreferencesReceipt(value: unknown): AppliedLaunchPreferencesReceipt | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== LAUNCH_PREFERENCES_RECEIPT_VERSION ||
    value.bankSchemaVersion !== SCHEMA_VERSION ||
    typeof value.telegramId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value.telegramId) ||
    typeof value.revisionEpoch !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.revisionEpoch) ||
    !isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    return null;
  }
  return {
    version: LAUNCH_PREFERENCES_RECEIPT_VERSION,
    bankSchemaVersion: SCHEMA_VERSION,
    telegramId: value.telegramId,
    revisionEpoch: value.revisionEpoch,
    revision: value.revision,
  };
}

function migrateLegacyTelegramNamespace(telegramId: string): void {
  const destination = keysFor(activeNamespace);
  if (destination.bank === null || destination.locale === null) return;

  try {
    const existing = loadPersistedFromKey(destination.bank, telegramId);
    const legacy = loadPersistedFromKey(LEGACY_TELEGRAM_NAMESPACE_ROOT, telegramId);
    let bankReady = existing.kind === 'ok';
    if (existing.kind === 'empty' && legacy.kind === 'ok') {
      localStorage.setItem(
        destination.bank,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: legacy.state }),
      );
      bankReady = true;
    }
    if (!bankReady || legacy.kind !== 'ok') return;

    if (localStorage.getItem(destination.locale) === null) {
      const legacyLocale = localStorage.getItem(`${LEGACY_TELEGRAM_NAMESPACE_ROOT}.locale`);
      if (isAppLocale(legacyLocale)) localStorage.setItem(destination.locale, legacyLocale);
    }

    const destinationReceipt = destination.launchPreferencesReceipt;
    if (
      destinationReceipt !== null &&
      localStorage.getItem(destinationReceipt) === null &&
      isAppLocale(localStorage.getItem(destination.locale))
    ) {
      const legacyReceiptRaw = localStorage.getItem(
        `${LEGACY_TELEGRAM_NAMESPACE_ROOT}.launch-preferences-receipt`,
      );
      if (legacyReceiptRaw !== null) {
        const legacyReceipt = parseLaunchPreferencesReceipt(
          JSON.parse(legacyReceiptRaw) as unknown,
        );
        if (legacyReceipt?.telegramId === telegramId) {
          localStorage.setItem(destinationReceipt, JSON.stringify(legacyReceipt));
        }
      }
    }
  } catch {
    // Migration is best-effort. The verified namespace remains active and
    // starts from a clean seed if storage is unavailable or legacy data is bad.
  }
}

/**
 * A receipt is valid only while the matching Telegram BankState and an explicit
 * locale preference still exist. This prevents an orphan marker from skipping
 * recovery after storage loss, corruption, or a schema bump.
 */
export function loadAppliedLaunchPreferencesReceipt(): AppliedLaunchPreferencesReceipt | null {
  const key = keysFor().launchPreferencesReceipt;
  if (key === null) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const receipt = parseLaunchPreferencesReceipt(JSON.parse(raw) as unknown);
    if (
      receipt === null ||
      (activeNamespace.telegramId !== undefined &&
        receipt.telegramId !== activeNamespace.telegramId) ||
      !isAppLocale(localStorage.getItem(keysFor().locale ?? ''))
    ) {
      return null;
    }
    const persisted = loadPersisted();
    if (
      persisted.kind !== 'ok' ||
      persisted.state.profile.telegramId !== receipt.telegramId
    ) {
      return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

export function saveAppliedLaunchPreferencesReceipt(
  receipt: AppliedLaunchPreferencesReceipt,
): boolean {
  const canonical = parseLaunchPreferencesReceipt(receipt);
  const key = keysFor().launchPreferencesReceipt;
  if (
    canonical === null ||
    key === null ||
    (activeNamespace.telegramId !== undefined &&
      canonical.telegramId !== activeNamespace.telegramId)
  ) {
    return false;
  }
  try {
    localStorage.setItem(key, JSON.stringify(canonical));
    return true;
  } catch {
    return false;
  }
}

export function onLocalePreferenceChange(cb: (locale: AppLocale) => void): () => void {
  const handler = (event: StorageEvent) => {
    const key = keysFor().locale;
    if (key === null || event.key !== key) return;
    cb(isAppLocale(event.newValue) ? event.newValue : DEFAULT_LOCALE);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/** Serialize read-modify-write transitions across same-origin browser tabs. */
export async function withPersistenceLock<T>(
  work: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return work();
  const namespace = activeNamespace;
  const lockName = keysFor(namespace).mutationLock;
  let entered = false;
  try {
    return await navigator.locks.request(lockName, { mode: 'exclusive', signal }, () => {
      entered = true;
      signal?.throwIfAborted();
      if (activeNamespace !== namespace) {
        throw new DOMException('Persistence namespace changed', 'AbortError');
      }
      return work();
    });
  } catch (error: unknown) {
    if (entered || signal?.aborted) throw error;
    if (activeNamespace !== namespace) {
      throw new DOMException('Persistence namespace changed', 'AbortError');
    }
    console.warn('[cometa] Web Locks unavailable; continuing without cross-tab serialization');
    signal?.throwIfAborted();
    return work();
  }
}

let launchPreferencesQueue: Promise<void> = Promise.resolve();

function waitForLaunchPreferencesTurn(
  previousTurn: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void previousTurn.then(onReady, onReady);
  });
}

/** Serialize the whole receipt check -> preference writes -> receipt commit. */
export async function withLaunchPreferencesLock<T>(
  signal: AbortSignal,
  work: () => T | Promise<T>,
): Promise<T> {
  let releaseTurn: VoidFunction = () => undefined;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const previousTurn = launchPreferencesQueue;
  launchPreferencesQueue = previousTurn.then(() => turn, () => turn);

  try {
    await waitForLaunchPreferencesTurn(previousTurn, signal);
    signal.throwIfAborted();
    if (typeof navigator === 'undefined' || navigator.locks === undefined) return await work();
    let entered = false;
    try {
      return await navigator.locks.request(
        LAUNCH_PREFERENCES_LOCK,
        { mode: 'exclusive', signal },
        () => {
          entered = true;
          signal.throwIfAborted();
          return work();
        },
      );
    } catch (error: unknown) {
      if (entered || signal.aborted) throw error;
      console.warn('[cometa] Launch preference lock unavailable; using the in-tab queue');
      signal.throwIfAborted();
      return await work();
    }
  } finally {
    releaseTurn();
  }
}

/**
 * Cross-tab sync: another tab wrote — reread instead of silently clobbering
 * each other (the documented two-tabs bug class).
 */
export function onCrossTabChange(cb: (state: BankState) => void): () => void {
  const handler = (e: StorageEvent) => {
    const key = keysFor().bank;
    if (key === null || e.key !== key || e.newValue === null) return;
    const result = loadPersisted();
    if (result.kind === 'ok') cb(result.state);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
