import type { BankState, Contact, Money } from './types';
import { appendRow, balanceOf } from './ledger';
import { applySettleAccount } from './interest';
import { rub } from './money';

/**
 * Deterministic demo history: same `nowISO` → byte-identical state.
 * Realism is a design requirement (docs/spec.md §5.4): salary on the 5th,
 * rent on the 1st, weekday/weekend spending rhythm, weekly interest
 * settlements — not uniform noise.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MerchantSpec {
  name: string;
  category: string;
  min: number; // rubles
  max: number;
  weight: number;
  /** Preferred hour window [from, to). */
  hours: [number, number];
  weekendBoost?: number;
}

const MERCHANTS: MerchantSpec[] = [
  { name: 'Яндекс Такси', category: 'transport', min: 190, max: 1450, weight: 3, hours: [8, 23] },
  { name: 'Пятёрочка', category: 'groceries', min: 320, max: 2600, weight: 3, hours: [10, 21] },
  { name: 'Магнит', category: 'groceries', min: 280, max: 1900, weight: 2, hours: [10, 21] },
  { name: 'Самокат', category: 'groceries', min: 450, max: 2300, weight: 2, hours: [11, 22] },
  { name: 'Лента', category: 'groceries', min: 900, max: 4300, weight: 1, hours: [11, 19], weekendBoost: 2.5 },
  { name: 'Cofix', category: 'coffee', min: 190, max: 520, weight: 2, hours: [8, 12] },
  { name: 'Кофемания', category: 'coffee', min: 350, max: 950, weight: 1, hours: [9, 13] },
  { name: 'Яндекс Еда', category: 'food', min: 780, max: 2400, weight: 2, hours: [18, 23], weekendBoost: 1.6 },
  { name: 'Вкусно — и точка', category: 'food', min: 390, max: 870, weight: 1, hours: [12, 16] },
  { name: 'Ozon', category: 'shopping', min: 560, max: 7800, weight: 1.5, hours: [10, 23], weekendBoost: 1.5 },
  { name: 'Wildberries', category: 'shopping', min: 430, max: 5200, weight: 1.5, hours: [10, 23], weekendBoost: 1.5 },
  { name: 'Аптека Ригла', category: 'health', min: 240, max: 1600, weight: 0.8, hours: [10, 20] },
  { name: 'РЖД', category: 'transport', min: 1200, max: 4900, weight: 0.3, hours: [8, 20] },
  { name: 'Литрес', category: 'entertainment', min: 250, max: 700, weight: 0.4, hours: [19, 23] },
];

const SUBSCRIPTIONS: Array<{ name: string; day: number; amount: number; category: string }> = [
  { name: 'Telegram Premium', day: 3, amount: 299, category: 'subscriptions' },
  { name: 'Яндекс Плюс', day: 12, amount: 399, category: 'subscriptions' },
  { name: 'Кинопоиск', day: 21, amount: 399, category: 'subscriptions' },
];

const CONTACT_NAMES = ['Аня', 'Дима', 'Мама', 'Ромик', 'Янис', 'Женя', 'Полина', 'Артём'];

export const CHECKING_ID = 'acc_checking';
export const SAVINGS_ID = 'acc_savings';
export const SAVINGS_APY = 0.14;

const HISTORY_DAYS = 92;

function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

function at(dayISO: string, hour: number, minute: number): string {
  const d = new Date(dayISO);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function buildSeed(nowISO: string): BankState {
  const rand = mulberry32(20260901);
  const now = new Date(nowISO);
  const start = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const startISO = start.toISOString();

  const contacts: Contact[] = CONTACT_NAMES.map((name, i) => ({
    id: `c_${i + 1}`,
    name,
    initials: initials(name),
  }));

  let state: BankState = {
    accounts: [
      {
        id: CHECKING_ID,
        type: 'checking',
        name: 'Текущий',
        number: '40817810200001548753',
        createdAt: startISO,
      },
      {
        id: SAVINGS_ID,
        type: 'savings',
        name: 'Накопительный',
        number: '42301810900002013416',
        apy: SAVINGS_APY,
        accrualAnchor: startISO,
        createdAt: startISO,
      },
    ],
    transactions: [],
    cards: [
      { id: 'card_1', accountId: CHECKING_ID, brand: 'visa', last4: '7213', holder: 'NIKITA COMETA', expiry: '09/29', design: 'midnight', status: 'active' },
      { id: 'card_2', accountId: CHECKING_ID, brand: 'mastercard', last4: '4406', holder: 'NIKITA COMETA', expiry: '01/28', design: 'ivory', status: 'active' },
      { id: 'card_3', accountId: SAVINGS_ID, brand: 'visa', last4: '1187', holder: 'NIKITA COMETA', expiry: '05/30', design: 'mint', status: 'active' },
    ],
    contacts,
    profile: { displayName: 'Никита' },
    nextSeq: 1,
    recentTransferIds: [],
  };

  // Opening balances.
  state = appendRow(state, {
    accountId: CHECKING_ID, amountMinor: rub(23_417.52), kind: 'seed',
    counterparty: 'Начальный баланс', category: 'other', createdAt: at(startISO, 8, 0),
  });
  state = appendRow(state, {
    accountId: SAVINGS_ID, amountMinor: rub(150_000), kind: 'seed',
    counterparty: 'Начальный баланс', category: 'other', createdAt: at(startISO, 8, 1),
  });

  const pick = (specs: MerchantSpec[], isWeekend: boolean): MerchantSpec => {
    const weights = specs.map((m) => m.weight * (isWeekend && m.weekendBoost ? m.weekendBoost : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = rand() * total;
    for (let i = 0; i < specs.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return specs[i];
    }
    return specs[specs.length - 1];
  };

  type DayEvent = {
    accountId: string;
    amountMinor: Money;
    kind: BankState['transactions'][number]['kind'];
    counterparty: string;
    category: string;
    transferGroupId?: string;
    createdAt: string;
  };

  let lastSettleDay = 0;
  for (let day = 1; day <= HISTORY_DAYS; day++) {
    const date = new Date(start.getTime() + day * 86_400_000);
    if (date > now) break;
    const dayISO = date.toISOString();
    const dom = date.getUTCDate();
    const dow = date.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const events: DayEvent[] = [];

    if (dom === 5) {
      events.push({
        accountId: CHECKING_ID, amountMinor: rub(185_000), kind: 'topup',
        counterparty: 'ООО «Орбита Лабс»', category: 'salary', createdAt: at(dayISO, 10, 12),
      });
    }
    if (dom === 1) {
      events.push({
        accountId: CHECKING_ID, amountMinor: -rub(52_000), kind: 'purchase',
        counterparty: 'Аренда квартиры', category: 'home', createdAt: at(dayISO, 9, 30),
      });
    }
    for (const sub of SUBSCRIPTIONS) {
      if (dom === sub.day) {
        events.push({
          accountId: CHECKING_ID, amountMinor: -rub(sub.amount), kind: 'purchase',
          counterparty: sub.name, category: sub.category, createdAt: at(dayISO, 6, 45),
        });
      }
    }
    // Occasional incoming P2P (~3/month).
    if (rand() < 0.1) {
      const from = contacts[Math.floor(rand() * contacts.length)];
      const amount = rub(Math.round(500 + rand() * 4500));
      events.push({
        accountId: CHECKING_ID, amountMinor: amount, kind: 'transfer_contact',
        counterparty: from.name, category: 'transfer',
        createdAt: at(dayISO, 12 + Math.floor(rand() * 9), Math.floor(rand() * 60)),
      });
    }
    // Daily purchases: weekdays 1-3, weekends 2-4.
    const purchases = (isWeekend ? 2 : 1) + Math.floor(rand() * 3);
    for (let p = 0; p < purchases; p++) {
      const merchant = pick(MERCHANTS, isWeekend);
      const rubles = merchant.min + rand() * (merchant.max - merchant.min);
      const hour = merchant.hours[0] + Math.floor(rand() * (merchant.hours[1] - merchant.hours[0]));
      events.push({
        accountId: CHECKING_ID, amountMinor: -Math.round(rubles * 100), kind: 'purchase',
        counterparty: merchant.name, category: merchant.category,
        createdAt: at(dayISO, hour, Math.floor(rand() * 60)),
      });
    }

    // Weekly interest settlement (as if the owner opened the app) — applied
    // first, at 09:05, before the day's spending.
    if (day - lastSettleDay >= 7) {
      state = applySettleAccount(state, SAVINGS_ID, at(dayISO, 9, 5));
      lastSettleDay = day;
    }

    // Apply the day's events in true chronological order so seq == time order.
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const ev of events) {
      // Keep the demo account out of the red: skip a purchase that would dip below 500 ₽.
      if (ev.amountMinor < 0 && balanceOf(state, ev.accountId) + ev.amountMinor < rub(500)) continue;
      state = appendRow(state, ev);
    }

    // Monthly auto top-up of savings on the 6th — after the salary landed on the 5th.
    if (dom === 6) {
      const groupId = `grp_seed_${day}`;
      const amount = rub(30_000);
      if (balanceOf(state, CHECKING_ID) - amount >= rub(500)) {
        state = appendRow(state, {
          accountId: CHECKING_ID, amountMinor: -amount, kind: 'transfer_own_out',
          counterparty: 'Накопительный', category: 'transfer', transferGroupId: groupId,
          createdAt: at(dayISO, 23, 45),
        });
        state = appendRow(state, {
          accountId: SAVINGS_ID, amountMinor: amount, kind: 'transfer_own_in',
          counterparty: 'Текущий', category: 'transfer', transferGroupId: groupId,
          createdAt: at(dayISO, 23, 45),
        });
      }
    }
  }

  // Recent transfers to a few contacts so the picker sorts naturally.
  const recentPicks = [1, 3, 0]; // Дима, Ромик, Аня
  recentPicks.forEach((idx, i) => {
    const daysAgo = 2 + i * 3;
    const when = new Date(now.getTime() - daysAgo * 86_400_000);
    const iso = at(when.toISOString(), 14 + i, 20);
    const amount = rub([1500, 3200, 800][i]);
    if (balanceOf(state, CHECKING_ID) > amount + rub(500)) {
      state = appendRow(state, {
        accountId: CHECKING_ID, amountMinor: -amount, kind: 'transfer_contact',
        counterparty: contacts[idx].name, category: 'transfer', createdAt: iso,
      });
      state = {
        ...state,
        contacts: state.contacts.map((c) => (c.id === contacts[idx].id ? { ...c, lastTransferAt: iso } : c)),
      };
    }
  });

  return state;
}
