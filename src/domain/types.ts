/** Integer minor units (kopecks). Never floats. */
export type Money = number;

export type AccountType = 'checking' | 'savings';

export interface Account {
  id: string;
  type: AccountType;
  name: string;
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
  | 'seed';

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
  counterparty?: string;
  category?: string;
  /** Links the two legs of an own-account transfer for UI grouping. */
  transferGroupId?: string;
  createdAt: string;
}

export type CardDesign = 'midnight' | 'ivory' | 'mint';

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
}

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
  accounts: Account[];
  transactions: Transaction[];
  cards: Card[];
  contacts: Contact[];
  profile: Profile;
  /** Next transaction seq. */
  nextSeq: number;
  /** Ring buffer of recent clientTransferIds — transfer idempotency. */
  recentTransferIds: string[];
}
