/** Integer ISO minor units (kopecks, cents, sen, etc.). Never floats. */
export type Money = number;

export type Currency = 'USD' | 'EUR' | 'RUB' | 'KZT' | 'THB' | 'VND' | 'IDR' | 'GEL';

export type ExchangeRateSource = 'frankfurter' | 'fallback';

/**
 * Rates are decimal strings to keep provider precision intact. Every value is
 * quoted as major currency units per one USD, including `USD: "1"`.
 */
export interface ExchangeRateSnapshot {
  readonly base: 'USD';
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly source: ExchangeRateSource;
  readonly rates: Readonly<Record<Currency, string>>;
}

export type AccountType = 'checking' | 'savings';
export type AccountRole =
  | 'primary-checking'
  | 'primary-savings'
  | 'companion-1'
  | 'companion-2'
  | 'custom';
export type AccountStatus = 'active' | 'closed';

export interface Account {
  id: string;
  type: AccountType;
  role: AccountRole;
  status: AccountStatus;
  closedAt?: string;
  name: string;
  currency: Currency;
  /** Mock account requisites shown on the details screen. */
  number: string;
  /** Annual percentage yield, e.g. 0.14. Savings only. */
  apy?: number;
  /** ISO timestamp of the last interest settlement. Savings only. */
  accrualAnchor?: string;
  createdAt: string;
}

export type TransactionKind =
  | 'purchase'
  | 'transfer_own_out'
  | 'transfer_own_in'
  | 'transfer_contact'
  | 'interest'
  | 'topup'
  | 'seed'
  | 'manual_income'
  | 'manual_expense'
  | 'balance_adjustment';

export type TransactionStatus = 'posted' | 'pending';

/** Immutable quote and amounts captured when an own-account FX transfer runs. */
export interface TransactionFxSnapshot {
  readonly fromCurrency: Currency;
  readonly toCurrency: Currency;
  readonly fromAmountMinor: Money;
  readonly toAmountMinor: Money;
  /** Target major units per one source major unit, as a decimal string. */
  readonly rate: string;
  /** Frozen provider quote: source major units per one USD. */
  readonly fromUsdRate: string;
  /** Frozen provider quote: target major units per one USD. */
  readonly toUsdRate: string;
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly source: ExchangeRateSource;
}

export interface Transaction {
  id: string;
  accountId: string;
  /** Monotonic across the whole ledger — total order even within one millisecond. */
  seq: number;
  /** Signed: + income, − expense. */
  amountMinor: Money;
  /**
   * Account balance right after this row. The account balance IS the last
   * row's snapshot — there is no separately mutated balance field anywhere.
   */
  balanceAfterMinor: Money;
  kind: TransactionKind;
  /** Omitted means posted. Pending rows may still reserve available balance. */
  status?: TransactionStatus;
  counterparty?: string;
  category?: string;
  /** Links the two legs of an own-account transfer for UI grouping. */
  transferGroupId?: string;
  /** Present on both legs of a cross-currency own-account transfer. */
  fxSnapshot?: Readonly<TransactionFxSnapshot>;
  /** Optional user-authored detail, normalized and validated at the command boundary. */
  note?: string;
  /** User-selected banking date. Append order remains `seq`/`createdAt`. */
  effectiveDate?: string;
  recurringRuleId?: string;
  /** Stable monthly occurrence identity: `${ruleId}:${YYYY-MM}`. */
  occurrenceKey?: string;
  createdAt: string;
}

export type CardDesign = 'midnight' | 'ivory' | 'mint';
export type CardFreezeReason = 'manual' | 'account_closed';

export interface Card {
  id: string;
  accountId: string;
  brand: 'visa' | 'mastercard';
  /** Full PAN is never stored or rendered anywhere — last4 only. */
  last4: string;
  holder: string;
  expiry: string;
  design: CardDesign;
  status: 'active' | 'frozen';
  freezeReason?: CardFreezeReason;
}

export type RecurringDirection = 'income' | 'expense';
export type RecurringPauseReason =
  | 'manual'
  | 'account_closed'
  | 'capacity'
  | 'overflow'
  | 'insufficient_funds';

export interface RecurringRule {
  id: string;
  accountId: string;
  direction: RecurringDirection;
  /** Positive magnitude in the account currency's minor units. */
  amountMinor: Money;
  counterparty: string;
  note?: string;
  category: string;
  cadence: 'monthly';
  /** Original billing day, 1..31. Month-end clamps never mutate it. */
  anchorDay: number;
  /** First clamped occurrence, YYYY-MM-DD. */
  startsOn: string;
  /** First occurrence not materialized yet, YYYY-MM-DD. */
  nextOccurrence: string;
  status: 'active' | 'paused';
  pauseReason?: RecurringPauseReason;
  createdAt: string;
}

export type DemoFixtureId =
  | 'owner-kzt-v1'
  | 'synthetic-thb-v1'
  | 'synthetic-vnd-v1'
  | 'synthetic-rub-v1'
  | 'synthetic-usd-v1'
  | 'synthetic-eur-v1'
  | 'synthetic-idr-v1'
  | 'synthetic-gel-v1';

export interface Contact {
  id: string;
  name: string;
  initials: string;
  lastTransferAt?: string;
}

export interface Profile {
  displayName: string;
  telegramId?: string;
}

export interface BankState {
  primaryCurrency: Currency;
  /** Currency used to construct the fixture; independent from reporting preference. */
  demoBaseCurrency: Currency;
  fixtureId: DemoFixtureId;
  exchangeRates: ExchangeRateSnapshot;
  accounts: Account[];
  transactions: Transaction[];
  cards: Card[];
  contacts: Contact[];
  profile: Profile;
  /** Next transaction seq. */
  nextSeq: number;
  /** Ring buffer of recent clientTransferIds — transfer idempotency. */
  recentTransferIds: string[];
  recurringRules: RecurringRule[];
}
