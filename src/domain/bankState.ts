import { convertMoneyAtBaseRates, quoteCrossRate, SUPPORTED_CURRENCIES } from './currency';
import { applySettleAll, epochDayUTC } from './interest';
import { ledgerErrors } from './invariants';
import {
  isAllowedEffectiveDate,
  isIsoDate,
  isIsoTimestamp,
  monthOccurrence,
  nextMonthOccurrence,
  normalizeUserText,
  utcDate,
} from './inputValidation';
import { isClientTransferId } from './transfer';
import { fixtureCompanionCurrencies } from './seed';
import type {
  Account,
  BankState,
  Card,
  Contact,
  Currency,
  DemoFixtureId,
  ExchangeRateSnapshot,
  Profile,
  RecurringRule,
  Transaction,
  TransactionFxSnapshot,
} from './types';

type UnknownRecord = Record<string, unknown>;

const ACCOUNT_TYPES = ['checking', 'savings'] as const;
const ACCOUNT_ROLES = ['primary-checking', 'primary-savings', 'companion-1', 'companion-2', 'custom'] as const;
const ACCOUNT_STATUSES = ['active', 'closed'] as const;
const TRANSACTION_KINDS = ['purchase', 'transfer_own_out', 'transfer_own_in', 'transfer_contact', 'interest', 'topup', 'seed', 'manual_income', 'manual_expense', 'balance_adjustment'] as const;
const TRANSACTION_STATUSES = ['posted', 'pending'] as const;
const CARD_BRANDS = ['visa', 'mastercard'] as const;
const CARD_DESIGNS = ['midnight', 'ivory', 'mint'] as const;
const CARD_STATUSES = ['active', 'frozen'] as const;
const CARD_FREEZE_REASONS = ['manual', 'account_closed'] as const;
const RATE_SOURCES = ['frankfurter', 'fallback'] as const;
const RECURRING_DIRECTIONS = ['income', 'expense'] as const;
const RECURRING_STATUSES = ['active', 'paused'] as const;
const RECURRING_PAUSE_REASONS = ['manual', 'account_closed', 'capacity', 'overflow', 'insufficient_funds'] as const;
const FIXTURE_IDS = ['owner-kzt-v1', 'synthetic-thb-v1', 'synthetic-vnd-v1', 'synthetic-rub-v1', 'synthetic-usd-v1', 'synthetic-eur-v1', 'synthetic-idr-v1', 'synthetic-gel-v1'] as const;
const MAX_ACCOUNT_APY = 1;
const MAX_ACCOUNTS = 24;
const MAX_TRANSACTIONS = 5_000;
const MAX_RECURRING_RULES = 64;
const MAX_CARDS = 64;
const MAX_CONTACTS = 256;
const MAX_RATE_DECIMAL_LENGTH = 64;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonEmptyText(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && normalizeUserText(value, maximum) === value;
}

function isOptional<T>(value: unknown, guard: (item: unknown) => item is T): value is T | undefined {
  return value === undefined || guard(value);
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function isCurrency(value: unknown): value is Currency {
  return isOneOf(value, SUPPORTED_CURRENCIES);
}

function isPositiveDecimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_RATE_DECIMAL_LENGTH &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    BigInt(value.replace('.', '')) > 0n
  );
}

function isRateDateCoherent(asOf: string, fetchedAt: string): boolean {
  const providerDay = Date.parse(`${asOf}T00:00:00.000Z`);
  const fetchedDay = Date.parse(`${fetchedAt.slice(0, 10)}T00:00:00.000Z`);
  const lag = (fetchedDay - providerDay) / 86_400_000;
  return Number.isFinite(lag) && lag >= 0 && lag <= 7;
}

function isRateSnapshot(value: unknown): value is ExchangeRateSnapshot {
  if (!isRecord(value) || value.base !== 'USD' || !isIsoDate(value.asOf) || !isIsoTimestamp(value.fetchedAt) || !isOneOf(value.source, RATE_SOURCES) || !isRecord(value.rates)) return false;
  const rates = value.rates;
  return (
    Object.keys(rates).length === SUPPORTED_CURRENCIES.length &&
    SUPPORTED_CURRENCIES.every((currency) => isPositiveDecimal(rates[currency])) &&
    rates.USD === '1' &&
    isRateDateCoherent(value.asOf, value.fetchedAt)
  );
}

function isAccount(value: unknown): value is Account {
  if (!isRecord(value) || !isNonEmptyText(value.id, 96) || !isOneOf(value.type, ACCOUNT_TYPES) || !isOneOf(value.role, ACCOUNT_ROLES) || !isOneOf(value.status, ACCOUNT_STATUSES) || !isNonEmptyText(value.name, 48) || !isCurrency(value.currency) || !isNonEmptyText(value.number, 40) || !isIsoTimestamp(value.createdAt) || !isOptional(value.closedAt, isIsoTimestamp)) return false;
  if ((value.status === 'active') !== (value.closedAt === undefined)) return false;
  if (value.closedAt !== undefined && Date.parse(value.closedAt) < Date.parse(value.createdAt)) return false;
  const validApy = value.apy === undefined || (typeof value.apy === 'number' && Number.isFinite(value.apy) && value.apy >= 0 && value.apy <= MAX_ACCOUNT_APY);
  const validAnchor = value.accrualAnchor === undefined || (isIsoTimestamp(value.accrualAnchor) && epochDayUTC(value.accrualAnchor) >= epochDayUTC(value.createdAt));
  const savingsFields = value.type === 'savings' ? value.apy !== undefined && value.accrualAnchor !== undefined : value.apy === undefined && value.accrualAnchor === undefined;
  return validApy && validAnchor && savingsFields;
}

function isFxSnapshot(value: unknown): value is TransactionFxSnapshot {
  if (!isRecord(value) || !isCurrency(value.fromCurrency) || !isCurrency(value.toCurrency) || value.fromCurrency === value.toCurrency || !isSafeInteger(value.fromAmountMinor) || value.fromAmountMinor <= 0 || !isSafeInteger(value.toAmountMinor) || value.toAmountMinor <= 0 || !isPositiveDecimal(value.rate) || !isPositiveDecimal(value.fromUsdRate) || !isPositiveDecimal(value.toUsdRate) || !isIsoDate(value.asOf) || !isIsoTimestamp(value.fetchedAt) || !isOneOf(value.source, RATE_SOURCES) || !isRateDateCoherent(value.asOf, value.fetchedAt)) return false;
  if ((value.fromCurrency === 'USD' && value.fromUsdRate !== '1') || (value.toCurrency === 'USD' && value.toUsdRate !== '1')) return false;
  const fromAmountMinor = value.fromAmountMinor;
  const toAmountMinor = value.toAmountMinor;
  if (!isSafeInteger(fromAmountMinor) || !isSafeInteger(toAmountMinor)) return false;
  try {
    return value.rate === quoteCrossRate(value.fromCurrency, value.toCurrency, value.fromUsdRate, value.toUsdRate) && convertMoneyAtBaseRates(fromAmountMinor, value.fromCurrency, value.toCurrency, value.fromUsdRate, value.toUsdRate) === toAmountMinor;
  } catch {
    return false;
  }
}

function isTransaction(value: unknown): value is Transaction {
  if (!isRecord(value)) return false;
  const valid = isNonEmptyText(value.id, 96) && isNonEmptyText(value.accountId, 96) && isSafeInteger(value.seq) && value.seq > 0 && isSafeInteger(value.amountMinor) && isSafeInteger(value.balanceAfterMinor) && isOneOf(value.kind, TRANSACTION_KINDS) && isOptional(value.status, (item): item is Transaction['status'] & string => isOneOf(item, TRANSACTION_STATUSES)) && isOptional(value.counterparty, (item): item is string => isNonEmptyText(item, 80)) && isOptional(value.category, (item): item is string => isNonEmptyText(item, 40)) && isOptional(value.transferGroupId, (item): item is string => isNonEmptyText(item, 96)) && isOptional(value.fxSnapshot, isFxSnapshot) && isOptional(value.note, (item): item is string => isNonEmptyText(item, 120)) && isOptional(value.effectiveDate, isIsoDate) && isOptional(value.recurringRuleId, (item): item is string => typeof item === 'string' && /^rr_[A-Za-z0-9_.:-]{1,92}$/.test(item)) && isOptional(value.occurrenceKey, (item): item is string => typeof item === 'string' && /^rr_[A-Za-z0-9_.:-]{1,92}:\d{4}-\d{2}$/.test(item)) && isIsoTimestamp(value.createdAt);
  if (!valid) return false;
  const amountMinor = value.amountMinor;
  if (!isSafeInteger(amountMinor)) return false;
  if ((value.recurringRuleId === undefined) !== (value.occurrenceKey === undefined)) return false;
  if (value.occurrenceKey !== undefined && value.effectiveDate === undefined) return false;
  if (value.kind === 'manual_income' && amountMinor <= 0) return false;
  if (value.kind === 'manual_expense' && amountMinor >= 0) return false;
  if (value.kind === 'balance_adjustment' && amountMinor === 0) return false;
  return true;
}

function isCard(value: unknown): value is Card {
  return isRecord(value) && isNonEmptyText(value.id, 96) && isNonEmptyText(value.accountId, 96) && isOneOf(value.brand, CARD_BRANDS) && typeof value.last4 === 'string' && /^\d{4}$/.test(value.last4) && isNonEmptyText(value.holder, 80) && typeof value.expiry === 'string' && /^(0[1-9]|1[0-2])\/\d{2}$/.test(value.expiry) && isOneOf(value.design, CARD_DESIGNS) && isOneOf(value.status, CARD_STATUSES) && isOptional(value.freezeReason, (item): item is Card['freezeReason'] & string => isOneOf(item, CARD_FREEZE_REASONS)) && !(value.status === 'active' && value.freezeReason !== undefined);
}

function isContact(value: unknown): value is Contact {
  return isRecord(value) && isNonEmptyText(value.id, 96) && isNonEmptyText(value.name, 80) && isNonEmptyText(value.initials, 8) && isOptional(value.lastTransferAt, isIsoTimestamp);
}

function isProfile(value: unknown): value is Profile {
  return isRecord(value) && isNonEmptyText(value.displayName, 48) && isOptional(value.telegramId, (item): item is string => typeof item === 'string' && /^[1-9]\d{0,19}$/.test(item));
}

function isRecurringRule(value: unknown): value is RecurringRule {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^rr_[A-Za-z0-9_.:-]{1,92}$/.test(value.id) || !isNonEmptyText(value.accountId, 96) || !isOneOf(value.direction, RECURRING_DIRECTIONS) || !isSafeInteger(value.amountMinor) || value.amountMinor <= 0 || !isNonEmptyText(value.counterparty, 80) || !isOptional(value.note, (item): item is string => isNonEmptyText(item, 120)) || !isNonEmptyText(value.category, 40) || value.cadence !== 'monthly' || !isSafeInteger(value.anchorDay) || value.anchorDay < 1 || value.anchorDay > 31 || !isIsoDate(value.startsOn) || !isIsoDate(value.nextOccurrence) || value.nextOccurrence < value.startsOn || !isOneOf(value.status, RECURRING_STATUSES) || !isOptional(value.pauseReason, (item): item is RecurringRule['pauseReason'] & string => isOneOf(item, RECURRING_PAUSE_REASONS)) || !isIsoTimestamp(value.createdAt)) return false;
  return (value.status === 'active') === (value.pauseReason === undefined);
}

function projectRateSnapshot(value: ExchangeRateSnapshot): ExchangeRateSnapshot {
  return {
    base: 'USD',
    asOf: value.asOf,
    fetchedAt: value.fetchedAt,
    source: value.source,
    rates: {
      USD: value.rates.USD,
      EUR: value.rates.EUR,
      RUB: value.rates.RUB,
      KZT: value.rates.KZT,
      THB: value.rates.THB,
      VND: value.rates.VND,
      IDR: value.rates.IDR,
      GEL: value.rates.GEL,
    },
  };
}

function projectAccount(value: Account): Account {
  return {
    id: value.id,
    type: value.type,
    role: value.role,
    status: value.status,
    ...(value.closedAt === undefined ? {} : { closedAt: value.closedAt }),
    name: value.name,
    currency: value.currency,
    number: value.number,
    ...(value.apy === undefined ? {} : { apy: value.apy }),
    ...(value.accrualAnchor === undefined ? {} : { accrualAnchor: value.accrualAnchor }),
    createdAt: value.createdAt,
  };
}

function projectFxSnapshot(value: TransactionFxSnapshot): TransactionFxSnapshot {
  return {
    fromCurrency: value.fromCurrency,
    toCurrency: value.toCurrency,
    fromAmountMinor: value.fromAmountMinor,
    toAmountMinor: value.toAmountMinor,
    rate: value.rate,
    fromUsdRate: value.fromUsdRate,
    toUsdRate: value.toUsdRate,
    asOf: value.asOf,
    fetchedAt: value.fetchedAt,
    source: value.source,
  };
}

function projectTransaction(value: Transaction): Transaction {
  return {
    id: value.id,
    accountId: value.accountId,
    seq: value.seq,
    amountMinor: value.amountMinor,
    balanceAfterMinor: value.balanceAfterMinor,
    kind: value.kind,
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.counterparty === undefined ? {} : { counterparty: value.counterparty }),
    ...(value.category === undefined ? {} : { category: value.category }),
    ...(value.transferGroupId === undefined ? {} : { transferGroupId: value.transferGroupId }),
    ...(value.fxSnapshot === undefined ? {} : { fxSnapshot: projectFxSnapshot(value.fxSnapshot) }),
    ...(value.note === undefined ? {} : { note: value.note }),
    ...(value.effectiveDate === undefined ? {} : { effectiveDate: value.effectiveDate }),
    ...(value.recurringRuleId === undefined ? {} : { recurringRuleId: value.recurringRuleId }),
    ...(value.occurrenceKey === undefined ? {} : { occurrenceKey: value.occurrenceKey }),
    createdAt: value.createdAt,
  };
}

function projectCard(value: Card): Card {
  return {
    id: value.id,
    accountId: value.accountId,
    brand: value.brand,
    last4: value.last4,
    holder: value.holder,
    expiry: value.expiry,
    design: value.design,
    status: value.status,
    ...(value.freezeReason === undefined ? {} : { freezeReason: value.freezeReason }),
  };
}

function projectContact(value: Contact): Contact {
  return {
    id: value.id,
    name: value.name,
    initials: value.initials,
    ...(value.lastTransferAt === undefined ? {} : { lastTransferAt: value.lastTransferAt }),
  };
}

function projectProfile(value: Profile): Profile {
  return {
    displayName: value.displayName,
    ...(value.telegramId === undefined ? {} : { telegramId: value.telegramId }),
  };
}

function projectRecurringRule(value: RecurringRule): RecurringRule {
  return {
    id: value.id,
    accountId: value.accountId,
    direction: value.direction,
    amountMinor: value.amountMinor,
    counterparty: value.counterparty,
    ...(value.note === undefined ? {} : { note: value.note }),
    category: value.category,
    cadence: 'monthly',
    anchorDay: value.anchorDay,
    startsOn: value.startsOn,
    nextOccurrence: value.nextOccurrence,
    status: value.status,
    ...(value.pauseReason === undefined ? {} : { pauseReason: value.pauseReason }),
    createdAt: value.createdAt,
  };
}

function hasUniqueIds<T extends { id: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function hasValidTransferGroups(transactions: Transaction[], accounts: Account[]): boolean {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const own = transaction.kind === 'transfer_own_out' || transaction.kind === 'transfer_own_in';
    if (own !== (transaction.transferGroupId !== undefined) || (!own && transaction.fxSnapshot !== undefined)) return false;
    if (transaction.transferGroupId) groups.set(transaction.transferGroupId, [...(groups.get(transaction.transferGroupId) ?? []), transaction]);
  }
  for (const [groupId, group] of groups) {
    const outgoing = group.find((transaction) => transaction.kind === 'transfer_own_out');
    const incoming = group.find((transaction) => transaction.kind === 'transfer_own_in');
    if (group.length !== 2 || !outgoing || !incoming || outgoing.accountId === incoming.accountId || outgoing.amountMinor >= 0 || incoming.amountMinor <= 0 || incoming.seq !== outgoing.seq + 1 || incoming.createdAt !== outgoing.createdAt || (/^grp_\d+$/.test(groupId) && groupId !== `grp_${outgoing.seq}`)) return false;
    const from = accountById.get(outgoing.accountId);
    const to = accountById.get(incoming.accountId);
    if (!from || !to) return false;
    if (from.currency === to.currency) {
      if (outgoing.fxSnapshot || incoming.fxSnapshot || -outgoing.amountMinor !== incoming.amountMinor) return false;
    } else if (!outgoing.fxSnapshot || !incoming.fxSnapshot || JSON.stringify(outgoing.fxSnapshot) !== JSON.stringify(incoming.fxSnapshot) || outgoing.fxSnapshot.fromCurrency !== from.currency || outgoing.fxSnapshot.toCurrency !== to.currency || outgoing.fxSnapshot.fromAmountMinor !== -outgoing.amountMinor || outgoing.fxSnapshot.toAmountMinor !== incoming.amountMinor) return false;
  }
  return true;
}

function hasValidTransactionAccountBoundaries(
  transactions: Transaction[],
  accounts: Account[],
  nowISO: string,
): boolean {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return transactions.every((transaction) => {
    const account = accountById.get(transaction.accountId);
    if (account === undefined) return false;
    if (Date.parse(transaction.createdAt) < Date.parse(account.createdAt)) return false;
    if (
      (transaction.kind === 'manual_income' || transaction.kind === 'manual_expense') &&
      (account.type !== 'checking' ||
        transaction.effectiveDate === undefined ||
        !isAllowedEffectiveDate(transaction.effectiveDate, transaction.createdAt) ||
        transaction.effectiveDate > utcDate(nowISO))
    ) {
      return false;
    }
    if (
      transaction.kind === 'balance_adjustment' &&
      account.type === 'savings' &&
      transaction.effectiveDate !== utcDate(transaction.createdAt)
    ) {
      return false;
    }
    if (account.status !== 'closed') return true;
    return (
      account.closedAt !== undefined &&
      Date.parse(transaction.createdAt) <= Date.parse(account.closedAt)
    );
  });
}

function hasContinuousRecurringOccurrences(
  transactions: Transaction[],
  rules: RecurringRule[],
): boolean {
  const occurrencesByRule = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    if (transaction.recurringRuleId === undefined) continue;
    const occurrences = occurrencesByRule.get(transaction.recurringRuleId) ?? [];
    occurrences.push(transaction);
    occurrencesByRule.set(transaction.recurringRuleId, occurrences);
  }

  return rules.every((rule) => {
    const occurrences = occurrencesByRule.get(rule.id) ?? [];
    const occurrenceByKey = new Map(
      occurrences.map((transaction) => [transaction.occurrenceKey, transaction]),
    );
    let expectedCount = 0;
    let cursor = rule.startsOn;
    while (cursor < rule.nextOccurrence) {
      if (expectedCount >= transactions.length) return false;
      const occurrence = occurrenceByKey.get(`${rule.id}:${cursor.slice(0, 7)}`);
      if (occurrence?.effectiveDate !== cursor) return false;
      expectedCount += 1;
      const next = nextMonthOccurrence(cursor, rule.anchorDay);
      if (next === null) return false;
      cursor = next;
    }
    return cursor === rule.nextOccurrence && occurrences.length === expectedCount;
  });
}

function fixtureMatchesCurrency(fixtureId: DemoFixtureId, currency: Currency): boolean {
  return fixtureId === (currency === 'KZT' ? 'owner-kzt-v1' : `synthetic-${currency.toLowerCase()}-v1`);
}

function hasCanonicalAccountRoles(accounts: Account[], demoBaseCurrency: Currency): boolean {
  const requiredRoles = [
    'primary-checking',
    'primary-savings',
    'companion-1',
    'companion-2',
  ] as const;
  if (
    requiredRoles.some(
      (role) => accounts.filter((account) => account.role === role).length !== 1,
    )
  ) {
    return false;
  }

  const primaryChecking = accounts.find((account) => account.role === 'primary-checking');
  const primarySavings = accounts.find((account) => account.role === 'primary-savings');
  const companion1 = accounts.find((account) => account.role === 'companion-1');
  const companion2 = accounts.find((account) => account.role === 'companion-2');
  const [companion1Currency, companion2Currency] = fixtureCompanionCurrencies(demoBaseCurrency);
  return (
    accounts.every((account) =>
      account.role === 'primary-savings'
        ? account.type === 'savings'
        : account.type === 'checking',
    ) &&
    primaryChecking?.currency === demoBaseCurrency &&
    primarySavings?.currency === demoBaseCurrency &&
    companion1?.currency === companion1Currency &&
    companion2?.currency === companion2Currency
  );
}

function hasUniqueActiveCheckingCurrencies(accounts: Account[]): boolean {
  const activeCheckingCurrencies = accounts
    .filter((account) => account.status === 'active' && account.type === 'checking')
    .map((account) => account.currency);
  return new Set(activeCheckingCurrencies).size === activeCheckingCurrencies.length;
}

function isRecurringStartBounded(rule: RecurringRule): boolean {
  const createdDate = utcDate(rule.createdAt);
  const startsLaterInCreationMonth =
    rule.startsOn > createdDate && rule.startsOn.slice(0, 7) === createdDate.slice(0, 7);
  if (!isAllowedEffectiveDate(rule.startsOn, rule.createdAt) && !startsLaterInCreationMonth) {
    return false;
  }

  let cursor = rule.startsOn;
  let initialOccurrences = 0;
  while (cursor <= createdDate) {
    initialOccurrences += 1;
    if (initialOccurrences > 120) return false;
    const next = nextMonthOccurrence(cursor, rule.anchorDay);
    if (next === null) return false;
    cursor = next;
  }
  return true;
}

export interface ParseBankStateOptions {
  readonly expectedTelegramId?: string;
}

/** Strict runtime boundary and exact BankState projection for browser and server adoption. */
export function parseBankState(value: unknown, nowISO: string, options: ParseBankStateOptions = {}): BankState | null {
  if (!isRecord(value) || !isIsoTimestamp(nowISO) || !isCurrency(value.primaryCurrency) || !isCurrency(value.demoBaseCurrency) || !isOneOf(value.fixtureId, FIXTURE_IDS) || !fixtureMatchesCurrency(value.fixtureId, value.demoBaseCurrency) || !isRateSnapshot(value.exchangeRates) || !isArrayOf(value.accounts, isAccount) || value.accounts.length === 0 || value.accounts.length > MAX_ACCOUNTS || !isArrayOf(value.transactions, isTransaction) || value.transactions.length > MAX_TRANSACTIONS || !isArrayOf(value.cards, isCard) || value.cards.length > MAX_CARDS || !isArrayOf(value.contacts, isContact) || value.contacts.length > MAX_CONTACTS || !isProfile(value.profile) || !isSafeInteger(value.nextSeq) || value.nextSeq <= 0 || !isArrayOf(value.recentTransferIds, isClientTransferId) || value.recentTransferIds.length > 50 || !isArrayOf(value.recurringRules, isRecurringRule) || value.recurringRules.length > MAX_RECURRING_RULES) return null;
  const candidate: BankState = {
    primaryCurrency: value.primaryCurrency,
    demoBaseCurrency: value.demoBaseCurrency,
    fixtureId: value.fixtureId,
    exchangeRates: projectRateSnapshot(value.exchangeRates),
    accounts: value.accounts.map(projectAccount),
    transactions: value.transactions.map(projectTransaction),
    cards: value.cards.map(projectCard),
    contacts: value.contacts.map(projectContact),
    profile: projectProfile(value.profile),
    nextSeq: value.nextSeq,
    recentTransferIds: [...value.recentTransferIds],
    recurringRules: value.recurringRules.map(projectRecurringRule),
  };
  const accountIds = new Set(candidate.accounts.map((account) => account.id));
  const ruleById = new Map(candidate.recurringRules.map((rule) => [rule.id, rule]));
  const occurrenceKeys = candidate.transactions.flatMap((transaction) => transaction.occurrenceKey ? [transaction.occurrenceKey] : []);
  const nowTimestamp = Date.parse(nowISO);
  const valid = hasUniqueIds(candidate.accounts) && hasUniqueIds(candidate.transactions) && hasUniqueIds(candidate.cards) && hasUniqueIds(candidate.contacts) && hasUniqueIds(candidate.recurringRules) && new Set(candidate.recentTransferIds).size === candidate.recentTransferIds.length && new Set(occurrenceKeys).size === occurrenceKeys.length && hasCanonicalAccountRoles(candidate.accounts, candidate.demoBaseCurrency) && hasUniqueActiveCheckingCurrencies(candidate.accounts) && candidate.exchangeRates.asOf <= utcDate(nowISO) && Date.parse(candidate.exchangeRates.fetchedAt) <= nowTimestamp && candidate.accounts.every((account) => Date.parse(account.createdAt) <= nowTimestamp && (account.closedAt === undefined || Date.parse(account.closedAt) <= nowTimestamp) && (account.accrualAnchor === undefined || (Date.parse(account.accrualAnchor) <= nowTimestamp && (account.closedAt === undefined || Date.parse(account.accrualAnchor) <= Date.parse(account.closedAt))))) && candidate.transactions.every((transaction) => Date.parse(transaction.createdAt) <= nowTimestamp && (transaction.fxSnapshot === undefined || (transaction.fxSnapshot.asOf <= utcDate(transaction.createdAt) && Date.parse(transaction.fxSnapshot.fetchedAt) <= Date.parse(transaction.createdAt)))) && candidate.contacts.every((contact) => contact.lastTransferAt === undefined || Date.parse(contact.lastTransferAt) <= nowTimestamp) && candidate.recurringRules.every((rule) => Date.parse(rule.createdAt) <= nowTimestamp && rule.startsOn.slice(0, 7) <= utcDate(nowISO).slice(0, 7) && isRecurringStartBounded(rule)) && candidate.transactions.every((transaction) => {
    if (transaction.id !== `tx_${transaction.seq}` || !accountIds.has(transaction.accountId)) return false;
    if (transaction.recurringRuleId === undefined) return true;
    const rule = ruleById.get(transaction.recurringRuleId);
    return rule !== undefined && transaction.accountId === rule.accountId && transaction.effectiveDate !== undefined && transaction.occurrenceKey === `${rule.id}:${transaction.effectiveDate.slice(0, 7)}` && Math.abs(transaction.amountMinor) === rule.amountMinor && ((rule.direction === 'expense' && transaction.kind === 'manual_expense' && transaction.amountMinor < 0) || (rule.direction === 'income' && transaction.kind === 'manual_income' && transaction.amountMinor > 0));
  }) && hasValidTransactionAccountBoundaries(candidate.transactions, candidate.accounts, nowISO) && hasContinuousRecurringOccurrences(candidate.transactions, candidate.recurringRules) && candidate.cards.every((card) => {
    const account = candidate.accounts.find((item) => item.id === card.accountId);
    return account !== undefined && (card.freezeReason !== 'account_closed' || account.status === 'closed') && (account.status !== 'closed' || card.status === 'frozen');
  }) && candidate.recurringRules.every((rule) => {
    const account = candidate.accounts.find((item) => item.id === rule.accountId);
    const nextYear = Number(rule.nextOccurrence.slice(0, 4));
    const nextMonth = Number(rule.nextOccurrence.slice(5, 7));
    const startYear = Number(rule.startsOn.slice(0, 4));
    const startMonth = Number(rule.startsOn.slice(5, 7));
    return account !== undefined && account.type === 'checking' && monthOccurrence(nextYear, nextMonth, rule.anchorDay) === rule.nextOccurrence && monthOccurrence(startYear, startMonth, rule.anchorDay) === rule.startsOn && (rule.status !== 'active' || account.status === 'active') && (rule.pauseReason !== 'account_closed' || account.status === 'closed');
  }) && candidate.nextSeq === (candidate.transactions.at(-1)?.seq ?? 0) + 1 && hasValidTransferGroups(candidate.transactions, candidate.accounts) && ledgerErrors(candidate).length === 0 && candidate.transactions.every((transaction) => transaction.balanceAfterMinor >= 0) && candidate.accounts.filter((account) => account.role === 'primary-checking').length === 1 && candidate.accounts.filter((account) => account.role === 'primary-savings').length === 1 && candidate.accounts.some((account) => account.status === 'active') && candidate.accounts.filter((account) => account.status === 'closed').every((account) => candidate.transactions.filter((transaction) => transaction.accountId === account.id).at(-1)?.balanceAfterMinor === 0) && (options.expectedTelegramId === undefined || candidate.profile.telegramId === options.expectedTelegramId);
  if (!valid) return null;
  try {
    applySettleAll(candidate, nowISO);
    return candidate;
  } catch {
    return null;
  }
}

/** Upgrade one strictly-shaped schema-v4 state by adding only v5-owned fields. */
export function migrateBankStateV4(value: unknown, nowISO: string, options: ParseBankStateOptions = {}): BankState | null {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !Array.isArray(value.cards)) return null;
  const accounts = value.accounts.map((item, index): unknown => {
    if (!isRecord(item)) return item;
    const role = item.type === 'savings' ? 'primary-savings' : index === 0 ? 'primary-checking' : index === 2 ? 'companion-1' : index === 3 ? 'companion-2' : 'custom';
    return { ...item, role, status: 'active' };
  });
  const cards = value.cards.map((item): unknown => {
    if (!isRecord(item)) return item;
    return item.status === 'frozen' ? { ...item, freezeReason: 'manual' } : item;
  });
  const base = isRecord(accounts[0]) && isCurrency(accounts[0].currency) ? accounts[0].currency : null;
  if (base === null) return null;
  return parseBankState(
    {
      ...value,
      demoBaseCurrency: base,
      fixtureId: base === 'KZT' ? 'owner-kzt-v1' : `synthetic-${base.toLowerCase()}-v1`,
      accounts,
      cards,
      recurringRules: [],
    },
    nowISO,
    options,
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

/** Stable JSON input for SHA-256 digests; object keys sort recursively, array order is preserved. */
export function canonicalBankStateJson(state: BankState): string {
  return JSON.stringify(canonicalize(state));
}
