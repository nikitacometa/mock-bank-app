import type { BankState, Contact, Currency, DemoFixtureId, Money } from './types';
import { appendRow, balanceOf } from './ledger';
import { applySettleAccount, applySettleAll } from './interest';
import { applyTransfer } from './transfer';
import { CURRENCY_METADATA, convertMoney } from './currency';
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

export const SEED_RATES_V1: BankState['exchangeRates'] = {
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

/** Freeze the accepted owner fixture to its original Bangkok wall-clock. */
function atLocalDate(date: string, hour: number, minute: number): string {
  return new Date(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`,
  ).toISOString();
}

function localDateAt(timestamp: number): string {
  return new Date(timestamp + 7 * 60 * 60 * 1_000).toISOString().slice(0, 10);
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
  const startTimestamp = new Date(`${RECENT_HISTORY_START_DATE}T12:00:00+07:00`).getTime();
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
    const day = Number(date.slice(8, 10));
    const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();
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

function buildOwnerKztSeed(nowISO: string): BankState {
  const requestedNowTimestamp = Date.parse(nowISO);
  if (!Number.isFinite(requestedNowTimestamp)) throw new RangeError('Seed timestamp must be valid');
  const demoEndTimestamp = new Date(`${DEMO_DATA_END_DATE}T23:59:59+07:00`).getTime();
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
      role: 'primary-checking',
      status: 'active',
      name: 'Текущий',
      currency: 'KZT',
      number: 'KZ86125KZT1001301123',
      createdAt: startISO,
    },
    {
      id: SAVINGS_ID,
      type: 'savings',
      role: 'primary-savings',
      status: 'active',
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
      role: 'companion-1',
      status: 'active',
      name: 'Доллары',
      currency: 'USD',
      number: 'KZ67125USD4001301126',
      createdAt: startISO,
    },
    {
      id: 'acc_eur',
      type: 'checking',
      role: 'companion-2',
      status: 'active',
      name: 'Евро',
      currency: 'EUR',
      number: 'KZ95125EUR5001301127',
      createdAt: startISO,
    },
  ];

  let state: BankState = {
    primaryCurrency: 'KZT',
    demoBaseCurrency: 'KZT',
    fixtureId: 'owner-kzt-v1',
    exchangeRates: SEED_RATES_V1,
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
    recurringRules: [],
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

const SYNTHETIC_FIXTURE_IDS: Readonly<Record<Exclude<Currency, 'KZT'>, DemoFixtureId>> = {
  THB: 'synthetic-thb-v1',
  VND: 'synthetic-vnd-v1',
  RUB: 'synthetic-rub-v1',
  USD: 'synthetic-usd-v1',
  EUR: 'synthetic-eur-v1',
  IDR: 'synthetic-idr-v1',
  GEL: 'synthetic-gel-v1',
};

const SYNTHETIC_MERCHANTS: Readonly<
  Record<Exclude<Currency, 'KZT'>, readonly { name: string; category: string }[]>
> = {
  THB: [
    { name: '7-Eleven', category: 'groceries' },
    { name: 'Grab', category: 'transport' },
    { name: 'LINE MAN', category: 'food' },
    { name: 'Café Amazon', category: 'coffee' },
    { name: 'BTS Rabbit', category: 'transport' },
  ],
  VND: [
    { name: 'Highlands Coffee', category: 'coffee' },
    { name: 'WinMart', category: 'groceries' },
    { name: 'Grab', category: 'transport' },
    { name: 'ShopeeFood', category: 'food' },
    { name: 'Be', category: 'transport' },
  ],
  RUB: [
    { name: 'Пятёрочка', category: 'groceries' },
    { name: 'Самокат', category: 'groceries' },
    { name: 'ВкусВилл', category: 'groceries' },
    { name: 'Ozon', category: 'shopping' },
    { name: 'Яндекс Go', category: 'transport' },
  ],
  USD: [
    { name: "Trader Joe's", category: 'groceries' },
    { name: 'Whole Foods', category: 'groceries' },
    { name: 'Uber', category: 'transport' },
    { name: 'DoorDash', category: 'food' },
    { name: 'Apple', category: 'subscriptions' },
  ],
  EUR: [
    { name: 'Lidl', category: 'groceries' },
    { name: 'Carrefour', category: 'groceries' },
    { name: 'Wolt', category: 'food' },
    { name: 'Bolt', category: 'transport' },
    { name: 'Deutsche Bahn', category: 'transport' },
  ],
  IDR: [
    { name: 'Gojek', category: 'transport' },
    { name: 'GoPay', category: 'transfer' },
    { name: 'Tokopedia', category: 'shopping' },
    { name: 'Indomaret', category: 'groceries' },
    { name: 'Alfamart', category: 'groceries' },
  ],
  GEL: [
    { name: 'Wolt', category: 'food' },
    { name: 'Bolt', category: 'transport' },
    { name: 'SPAR', category: 'groceries' },
    { name: 'Magniti', category: 'groceries' },
    { name: 'Magti', category: 'subscriptions' },
  ],
};

const ROLE_TARGET_USD_CENTS = {
  checking: 133_247,
  savings: 2_142_427,
  companion1: 80_000,
  companion2: 46_454,
} as const;

const SYNTHETIC_EVENT_COUNT = 432;
const SYNTHETIC_SCHEDULE_DAYS = 254;

function visibleCurrencyAmount(usdCents: Money, currency: Currency): Money {
  const converted = convertMoney(usdCents, 'USD', currency, SEED_RATES_V1);
  const hiddenScale = 10n ** BigInt(
    CURRENCY_METADATA[currency].minorUnits - CURRENCY_METADATA[currency].displayDigits,
  );
  if (hiddenScale === 1n) return converted;
  const value = BigInt(converted);
  const rounded = ((value + hiddenScale / 2n) / hiddenScale) * hiddenScale;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Synthetic amount overflow');
  return Number(rounded);
}

/** Canonical companion-role currencies for every version-1 fixture. */
export function fixtureCompanionCurrencies(base: Currency): readonly [Currency, Currency] {
  if (base === 'USD') return ['EUR', 'KZT'];
  if (base === 'EUR') return ['USD', 'KZT'];
  return ['USD', 'EUR'];
}

function syntheticDate(index: number): { createdAt: string; effectiveDate: string } {
  const start = Date.UTC(2025, 11, 20, 12, 0, 0, 0);
  const dayOffset = Math.floor(
    (index * SYNTHETIC_SCHEDULE_DAYS) / (SYNTHETIC_EVENT_COUNT - 1),
  );
  const firstIndexOnDay = Math.ceil(
    (dayOffset * (SYNTHETIC_EVENT_COUNT - 1)) / SYNTHETIC_SCHEDULE_DAYS,
  );
  const timestamp = start + dayOffset * DAY_MS + (index - firstIndexOnDay) * 37 * 60_000;
  const createdAt = new Date(timestamp).toISOString();
  return { createdAt, effectiveDate: createdAt.slice(0, 10) };
}

function buildSyntheticSeed(nowISO: string, base: Exclude<Currency, 'KZT'>): BankState {
  const requestedNow = Date.parse(nowISO);
  if (!Number.isFinite(requestedNow)) throw new RangeError('Seed timestamp must be valid');
  const effectiveNow = Math.min(requestedNow, Date.parse('2026-09-02T23:59:59.999Z'));
  const [companion1, companion2] = fixtureCompanionCurrencies(base);
  const startISO = '2025-12-19T12:00:00.000Z';
  const accounts: BankState['accounts'] = [
    { id: CHECKING_ID, type: 'checking', role: 'primary-checking', status: 'active', name: 'Current', currency: base, number: `CM01${base}000000000001`, createdAt: startISO },
    { id: SAVINGS_ID, type: 'savings', role: 'primary-savings', status: 'active', name: 'Savings', currency: base, number: `CM02${base}000000000002`, apy: SAVINGS_APY, accrualAnchor: '2026-09-02T12:00:00.000Z', createdAt: startISO },
    { id: `acc_${companion1.toLowerCase()}`, type: 'checking', role: 'companion-1', status: 'active', name: companion1, currency: companion1, number: `CM03${companion1}000000000003`, createdAt: startISO },
    { id: `acc_${companion2.toLowerCase()}`, type: 'checking', role: 'companion-2', status: 'active', name: companion2, currency: companion2, number: `CM04${companion2}000000000004`, createdAt: startISO },
  ];
  const merchants = SYNTHETIC_MERCHANTS[base];
  const events = Array.from({ length: SYNTHETIC_EVENT_COUNT }, (_, index) => {
    const isIncome = index % 50 === 0;
    const usdCents = isIncome ? 60_000 : 350 + ((index * 977) % 7_650);
    const merchant = merchants[index % merchants.length];
    return {
      ...syntheticDate(index),
      amountMinor: visibleCurrencyAmount(usdCents, base) * (isIncome ? 1 : -1),
      kind: isIncome ? ('topup' as const) : ('purchase' as const),
      counterparty: isIncome ? 'External account top up' : merchant.name,
      category: isIncome ? 'transfer' : merchant.category,
    };
  });
  const eventNet = events.reduce((sum, event) => sum + event.amountMinor, 0);
  const checkingTarget = visibleCurrencyAmount(ROLE_TARGET_USD_CENTS.checking, base);
  const openingChecking = checkingTarget - eventNet;
  if (!Number.isSafeInteger(openingChecking) || openingChecking < 0) {
    throw new RangeError('Synthetic opening balance is invalid');
  }
  const openingBalances: readonly Money[] = [
    openingChecking,
    visibleCurrencyAmount(ROLE_TARGET_USD_CENTS.savings, base),
    visibleCurrencyAmount(ROLE_TARGET_USD_CENTS.companion1, companion1),
    visibleCurrencyAmount(ROLE_TARGET_USD_CENTS.companion2, companion2),
  ];
  let state: BankState = {
    primaryCurrency: base,
    demoBaseCurrency: base,
    fixtureId: SYNTHETIC_FIXTURE_IDS[base],
    exchangeRates: SEED_RATES_V1,
    accounts,
    transactions: [],
    cards: [
      { id: 'card_1', accountId: CHECKING_ID, brand: 'visa', last4: '7213', holder: 'COMETA DEMO', expiry: '09/29', design: 'midnight', status: 'active' },
      { id: 'card_2', accountId: accounts[2].id, brand: 'mastercard', last4: '4406', holder: 'COMETA DEMO', expiry: '01/28', design: 'ivory', status: 'active' },
      { id: 'card_3', accountId: SAVINGS_ID, brand: 'visa', last4: '1187', holder: 'COMETA DEMO', expiry: '05/30', design: 'mint', status: 'active' },
    ],
    contacts: CONTACT_NAMES.map((name, index) => ({ id: `c_${index + 1}`, name, initials: initials(name) })),
    profile: { displayName: 'Cometa' },
    nextSeq: 1,
    recentTransferIds: [],
    recurringRules: [],
  };
  for (const [index, account] of accounts.entries()) {
    state = appendRow(state, {
      accountId: account.id,
      amountMinor: openingBalances[index],
      kind: 'seed',
      counterparty: 'Opening balance',
      category: 'other',
      effectiveDate: '2025-12-19',
      createdAt: new Date(Date.parse(startISO) + index * 60_000).toISOString(),
    });
  }
  for (const event of events) {
    if (Date.parse(event.createdAt) > effectiveNow) continue;
    state = appendRow(state, { accountId: CHECKING_ID, ...event });
  }
  if (effectiveNow >= Date.parse('2026-08-31T23:59:59.999Z') && balanceOf(state, CHECKING_ID) !== checkingTarget) {
    throw new Error('Synthetic checking calibration drifted');
  }
  return state;
}

/** Build a deterministic four-account fixture for any supported base currency. */
export function buildSeed(nowISO: string, demoBaseCurrency: Currency = 'KZT'): BankState {
  return demoBaseCurrency === 'KZT'
    ? buildOwnerKztSeed(nowISO)
    : buildSyntheticSeed(nowISO, demoBaseCurrency);
}

/** Explicit destructive fixture switch. Profile and the freshest known rates survive the reset. */
export function rebuildDemoBase(
  current: BankState,
  demoBaseCurrency: Currency,
  nowISO: string,
): BankState {
  const seeded = buildSeed(nowISO, demoBaseCurrency);
  return applySettleAll(
    {
      ...seeded,
      primaryCurrency: demoBaseCurrency,
      exchangeRates: current.exchangeRates,
      profile: current.profile,
      recentTransferIds: [],
      recurringRules: [],
    },
    nowISO,
  );
}
