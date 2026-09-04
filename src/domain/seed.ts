import type { BankState, Contact, Money } from './types';
import { appendRow, balanceOf } from './ledger';
import { applySettleAccount } from './interest';
import { applyTransfer } from './transfer';
import { STATEMENT_ROWS } from './statementData';

/**
 * Deterministic, privacy-sanitized owner demo. Statement merchants, dates and
 * KZT amounts are preserved; personal counterparties and bank identifiers are
 * deliberately absent from the fixture.
 */

interface MerchantSpec {
  readonly name: string;
  readonly category: string;
  readonly minMajor: number;
  readonly maxMajor: number;
  readonly weight: number;
  readonly hours: readonly [number, number];
  readonly weekendBoost?: number;
}

const RECENT_MERCHANTS: readonly MerchantSpec[] = [
  { name: 'GoPay', category: 'transport', minMajor: 1_200, maxMajor: 8_500, weight: 3.2, hours: [8, 23] },
  { name: 'Yandex Go', category: 'transport', minMajor: 1_100, maxMajor: 7_200, weight: 2.4, hours: [8, 23] },
  { name: 'Yandex Eats', category: 'food', minMajor: 3_300, maxMajor: 13_500, weight: 1.5, hours: [17, 23], weekendBoost: 1.6 },
  { name: 'Suka Kopi', category: 'coffee', minMajor: 3_800, maxMajor: 7_200, weight: 1.5, hours: [8, 14] },
  { name: 'Kagemusha', category: 'food', minMajor: 2_900, maxMajor: 5_200, weight: 1.3, hours: [12, 22] },
  { name: 'Outpost', category: 'coffee', minMajor: 1_100, maxMajor: 28_000, weight: 0.9, hours: [9, 19] },
  { name: 'Pepito Market', category: 'groceries', minMajor: 5_500, maxMajor: 48_000, weight: 1.3, hours: [9, 21], weekendBoost: 1.4 },
  { name: 'Qazaq Energy', category: 'transport', minMajor: 3_500, maxMajor: 12_000, weight: 0.55, hours: [9, 21] },
  { name: 'Silk Way Car Rent', category: 'transport', minMajor: 20_000, maxMajor: 49_000, weight: 0.25, hours: [9, 19] },
  { name: 'Booking.com', category: 'transport', minMajor: 55_000, maxMajor: 140_000, weight: 0.12, hours: [10, 20], weekendBoost: 1.3 },
];

const CONTACT_NAMES = ['Айдана', 'Данияр', 'Апа', 'Руслан', 'Ержан', 'Жанна', 'Полина', 'Арман'];

export const CHECKING_ID = 'acc_checking';
export const SAVINGS_ID = 'acc_savings';
export const SAVINGS_APY = 0.14;
export const STATEMENT_OPENING_BALANCE_MINOR = 2_131_342_188;
export const STATEMENT_CLOSING_BALANCE_MINOR = 1_110_051_926;

const STATEMENT_RECONCILIATION_MINOR = 457_126;
const DEMO_DATA_END_DATE = '2026-09-02';
const RECENT_HISTORY_START_DATE = '2026-07-02';
const DAY_MS = 86_400_000;
const KZT_MINOR_SCALE = 100;
const CHECKING_FLOOR_MINOR = 50_000 * KZT_MINOR_SCALE;

const FALLBACK_EXCHANGE_RATES: BankState['exchangeRates'] = {
  base: 'USD',
  asOf: '2026-08-28',
  // Safely precedes the Aug 31 local-time conversions even at UTC+14.
  fetchedAt: '2026-08-30T00:20:00.000Z',
  source: 'fallback',
  rates: {
    USD: '1',
    EUR: '0.86107',
    RUB: '86.24',
    KZT: '462.27',
    THB: '33.136',
    VND: '26044',
    IDR: '17710',
    GEL: '2.6121',
  },
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function kzt(major: number): Money {
  return Math.round(major * KZT_MINOR_SCALE);
}

function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/** Build a local wall-clock timestamp because transaction time is rendered locally. */
function atLocalDate(date: string, hour: number, minute: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

function localDateAt(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface SeedRow {
  readonly accountId: string;
  readonly amountMinor: Money;
  readonly kind: BankState['transactions'][number]['kind'];
  readonly status?: BankState['transactions'][number]['status'];
  readonly counterparty: string;
  readonly category: string;
}

type SeedOperation =
  | { readonly type: 'row'; readonly row: SeedRow; readonly contactId?: string }
  | { readonly type: 'settle'; readonly accountId: string }
  | {
      readonly type: 'portfolio_transfer';
      readonly toAccountId: string;
      readonly amountMinor: Money;
      readonly clientTransferId: string;
    };

interface ScheduledSeedEvent {
  readonly createdAt: string;
  readonly insertionOrder: number;
  readonly operation: SeedOperation;
}

function pickMerchant(rand: () => number, isWeekend: boolean): MerchantSpec {
  const weights = RECENT_MERCHANTS.map(
    (merchant) => merchant.weight * (isWeekend && merchant.weekendBoost ? merchant.weekendBoost : 1),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rand() * total;
  for (let index = 0; index < RECENT_MERCHANTS.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return RECENT_MERCHANTS[index];
  }
  return RECENT_MERCHANTS[RECENT_MERCHANTS.length - 1];
}

function scheduleStatementRows(
  schedule: (createdAt: string, operation: SeedOperation) => void,
): void {
  let cursor = 0;
  while (cursor < STATEMENT_ROWS.length) {
    const date = STATEMENT_ROWS[cursor].date;
    let end = cursor + 1;
    while (end < STATEMENT_ROWS.length && STATEMENT_ROWS[end].date === date) end += 1;
    const count = end - cursor;
    for (let index = 0; index < count; index += 1) {
      const row = STATEMENT_ROWS[cursor + index];
      const minuteOfDay = 8 * 60 + Math.floor((index * 14 * 60) / Math.max(1, count));
      schedule(atLocalDate(date, Math.floor(minuteOfDay / 60), minuteOfDay % 60), {
        type: 'row',
        row: {
          accountId: CHECKING_ID,
          amountMinor: row.amountMinor,
          kind: row.kind,
          ...('status' in row ? { status: row.status } : {}),
          counterparty: row.counterparty,
          category: row.category,
        },
      });
    }
    cursor = end;
  }
}

function scheduleRecentHistory(
  schedule: (createdAt: string, operation: SeedOperation) => void,
  effectiveNowTimestamp: number,
  contacts: readonly Contact[],
): Money {
  const rand = mulberry32(20260902);
  const startTimestamp = new Date(`${RECENT_HISTORY_START_DATE}T12:00:00`).getTime();
  let appliedNetMinor = 0;
  const scheduleCheckingRow = (
    createdAt: string,
    row: Omit<SeedRow, 'accountId'>,
    contactId?: string,
  ): void => {
    schedule(createdAt, {
      type: 'row',
      row: { ...row, accountId: CHECKING_ID },
      ...(contactId === undefined ? {} : { contactId }),
    });
    if (Date.parse(createdAt) <= effectiveNowTimestamp) appliedNetMinor += row.amountMinor;
  };

  for (let timestamp = startTimestamp; timestamp <= effectiveNowTimestamp; timestamp += DAY_MS) {
    const date = localDateAt(timestamp);
    const day = new Date(timestamp).getDate();
    const dayOfWeek = new Date(timestamp).getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (day === 16) {
      scheduleCheckingRow(atLocalDate(date, 9, 12), {
          amountMinor: -320_866,
          kind: 'purchase',
          counterparty: 'Spotify',
          category: 'subscriptions',
      });
    }
    if (day === 19) {
      scheduleCheckingRow(atLocalDate(date, 9, 18), {
          amountMinor: -1_143_482,
          kind: 'purchase',
          counterparty: 'ChatGPT',
          category: 'subscriptions',
      });
    }

    if (rand() < (isWeekend ? 0.78 : 0.58)) {
      const purchases = rand() < (isWeekend ? 0.42 : 0.2) ? 2 : 1;
      for (let purchaseIndex = 0; purchaseIndex < purchases; purchaseIndex += 1) {
        const merchant = pickMerchant(rand, isWeekend);
        const amountMajor =
          merchant.minMajor + rand() * (merchant.maxMajor - merchant.minMajor);
        const hour =
          merchant.hours[0] + Math.floor(rand() * (merchant.hours[1] - merchant.hours[0]));
        scheduleCheckingRow(atLocalDate(date, hour, Math.floor(rand() * 60)), {
            amountMinor: -kzt(amountMajor),
            kind: 'purchase',
            counterparty: merchant.name,
            category: merchant.category,
        });
      }
    }
  }

  const topUps = [
    ['2026-07-11', 100_000],
    ['2026-08-12', 80_000],
  ] as const;
  for (const [date, amountMajor] of topUps) {
    scheduleCheckingRow(atLocalDate(date, 11, 10), {
        amountMinor: kzt(amountMajor),
        kind: 'topup',
        counterparty: 'Пополнение с внешнего счёта',
        category: 'transfer',
    });
  }

  const contactBeats = [
    { contactIndex: 0, date: '2026-07-24', hour: 16, amountMajor: 8_000 },
    { contactIndex: 3, date: '2026-08-17', hour: 15, amountMajor: 32_000 },
    { contactIndex: 1, date: '2026-08-30', hour: 14, amountMajor: 15_000 },
  ] as const;
  for (const beat of contactBeats) {
    const contact = contacts[beat.contactIndex];
    scheduleCheckingRow(
      atLocalDate(beat.date, beat.hour, 20),
      {
        amountMinor: -kzt(beat.amountMajor),
        kind: 'transfer_contact',
        counterparty: contact.name,
        category: 'transfer',
      },
      contact.id,
    );
  }

  return appliedNetMinor;
}

export function buildSeed(nowISO: string): BankState {
  const requestedNowTimestamp = Date.parse(nowISO);
  if (!Number.isFinite(requestedNowTimestamp)) throw new RangeError('Seed timestamp must be valid');
  const demoEndTimestamp = new Date(`${DEMO_DATA_END_DATE}T23:59:59`).getTime();
  const effectiveNowTimestamp = Math.min(requestedNowTimestamp, demoEndTimestamp);
  const startISO = atLocalDate('2025-12-19', 6, 0);
  const contacts: Contact[] = CONTACT_NAMES.map((name, index) => ({
    id: `c_${index + 1}`,
    name,
    initials: initials(name),
  }));

  const accounts: BankState['accounts'] = [
    {
      id: CHECKING_ID,
      type: 'checking',
      name: 'Текущий',
      currency: 'KZT',
      number: 'KZ86125KZT1001301123',
      createdAt: startISO,
    },
    {
      id: SAVINGS_ID,
      type: 'savings',
      name: 'Накопительный',
      currency: 'KZT',
      number: 'KZ11125KZT2001301124',
      apy: SAVINGS_APY,
      accrualAnchor: atLocalDate('2026-08-31', 8, 0),
      createdAt: startISO,
    },
    {
      id: 'acc_usd',
      type: 'checking',
      name: 'Доллары',
      currency: 'USD',
      number: 'KZ67125USD4001301126',
      createdAt: startISO,
    },
    {
      id: 'acc_eur',
      type: 'checking',
      name: 'Евро',
      currency: 'EUR',
      number: 'KZ95125EUR5001301127',
      createdAt: startISO,
    },
  ];

  let state: BankState = {
    primaryCurrency: 'KZT',
    exchangeRates: FALLBACK_EXCHANGE_RATES,
    accounts,
    transactions: [],
    cards: [
      { id: 'card_1', accountId: CHECKING_ID, brand: 'visa', last4: '7213', holder: 'NIKITA COMETA', expiry: '09/29', design: 'midnight', status: 'active' },
      { id: 'card_2', accountId: 'acc_usd', brand: 'mastercard', last4: '4406', holder: 'NIKITA COMETA', expiry: '01/28', design: 'ivory', status: 'active' },
      { id: 'card_3', accountId: SAVINGS_ID, brand: 'visa', last4: '1187', holder: 'NIKITA COMETA', expiry: '05/30', design: 'mint', status: 'active' },
    ],
    contacts,
    profile: { displayName: 'Никита' },
    nextSeq: 1,
    recentTransferIds: [],
  };

  const openingBalances: Readonly<Record<string, Money>> = {
    [CHECKING_ID]: STATEMENT_OPENING_BALANCE_MINOR,
    [SAVINGS_ID]: 0,
    acc_usd: 0,
    acc_eur: 0,
  };
  for (const [index, account] of accounts.entries()) {
    state = appendRow(state, {
      accountId: account.id,
      amountMinor: openingBalances[account.id],
      kind: 'seed',
      counterparty: 'Начальный баланс',
      category: 'other',
      createdAt: atLocalDate('2025-12-19', 6, index),
    });
  }

  const events: ScheduledSeedEvent[] = [];
  const schedule = (createdAt: string, operation: SeedOperation): void => {
    events.push({ createdAt, insertionOrder: events.length, operation });
  };

  scheduleStatementRows(schedule);
  // The PDF's printed closing balance is 4,571.26 KZT above the arithmetic sum
  // of its opening balance and all detailed rows. Preserve the certified close.
  schedule(atLocalDate('2026-06-30', 12, 0), {
    type: 'row',
    row: {
      accountId: CHECKING_ID,
      amountMinor: STATEMENT_RECONCILIATION_MINOR,
      kind: 'seed',
      counterparty: 'Сверка итогового баланса',
      category: 'other',
    },
  });

  const recentNetMinor = scheduleRecentHistory(schedule, effectiveNowTimestamp, contacts);
  if (recentNetMinor !== 0) {
    schedule(atLocalDate('2026-08-31', 7, 30), {
      type: 'row',
      row: {
        accountId: CHECKING_ID,
        amountMinor: -recentNetMinor,
        kind: recentNetMinor < 0 ? 'topup' : 'purchase',
        counterparty:
          recentNetMinor < 0 ? 'Пополнение с внешнего счёта' : 'Резерв на расходы',
        category: recentNetMinor < 0 ? 'transfer' : 'other',
      },
    });
  }

  schedule(atLocalDate('2026-08-31', 8, 0), {
    type: 'portfolio_transfer',
    toAccountId: SAVINGS_ID,
    amountMinor: kzt(9_900_000),
    clientTransferId: 'ct_seed_allocate_savings',
  });
  schedule(atLocalDate('2026-08-31', 8, 5), {
    type: 'portfolio_transfer',
    toAccountId: 'acc_usd',
    amountMinor: kzt(369_816),
    clientTransferId: 'ct_seed_allocate_usd',
  });
  schedule(atLocalDate('2026-08-31', 8, 10), {
    type: 'portfolio_transfer',
    toAccountId: 'acc_eur',
    amountMinor: kzt(214_743.69),
    clientTransferId: 'ct_seed_allocate_eur',
  });
  schedule(atLocalDate('2026-09-01', 9, 5), {
    type: 'settle',
    accountId: SAVINGS_ID,
  });

  events.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.insertionOrder - right.insertionOrder,
  );

  for (const event of events) {
    if (Date.parse(event.createdAt) > effectiveNowTimestamp) continue;
    if (event.operation.type === 'settle') {
      state = applySettleAccount(state, event.operation.accountId, event.createdAt);
      continue;
    }
    if (event.operation.type === 'portfolio_transfer') {
      const outcome = applyTransfer(state, {
        fromAccountId: CHECKING_ID,
        toAccountId: event.operation.toAccountId,
        amountMinor: event.operation.amountMinor,
        clientTransferId: event.operation.clientTransferId,
        nowISO: event.createdAt,
      });
      if (!outcome.ok || !outcome.applied) {
        throw new Error(
          `Unable to allocate the demo portfolio: ${outcome.ok ? 'duplicate' : outcome.error}`,
        );
      }
      state = outcome.state;
      continue;
    }

    const { row, contactId } = event.operation;
    if (
      row.amountMinor < 0 &&
      row.accountId === CHECKING_ID &&
      balanceOf(state, row.accountId) + row.amountMinor < CHECKING_FLOOR_MINOR
    ) {
      continue;
    }
    state = appendRow(state, { ...row, createdAt: event.createdAt });
    if (contactId) {
      state = {
        ...state,
        contacts: state.contacts.map((contact) =>
          contact.id === contactId ? { ...contact, lastTransferAt: event.createdAt } : contact,
        ),
      };
    }
  }

  return { ...state, recentTransferIds: [] };
}
