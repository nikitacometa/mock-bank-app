import type { Account, Transaction } from '@/domain/types';
import { currencyName, translate, type AppLocale, type TranslationKey } from '@/i18n';

const MONTH_NAMES: Readonly<Record<AppLocale, readonly string[]>> = {
  ru: [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};

const RATE_DATE_FORMATTERS: Readonly<
  Record<AppLocale, Readonly<Record<'short' | 'full', Intl.DateTimeFormat>>>
> = {
  ru: {
    short: new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }),
    full: new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  },
  en: {
    short: new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }),
    full: new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  },
};

export function fmtTime(iso: string, locale: AppLocale = 'ru'): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (locale === 'ru') return `${String(hours).padStart(2, '0')}:${minutes}`;

  const meridiem = hours < 12 ? 'AM' : 'PM';
  const twelveHour = hours % 12 || 12;
  return `${twelveHour}:${minutes} ${meridiem}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function fmtDay(iso: string, locale: AppLocale = 'ru', now = new Date()): string {
  const d = new Date(iso);
  if (sameLocalDay(d, now)) return translate(locale, 'date.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return translate(locale, 'date.yesterday');
  const day = d.getDate();
  const month = MONTH_NAMES[locale][d.getMonth()];
  if (d.getFullYear() === now.getFullYear()) {
    return locale === 'ru' ? `${day} ${month}` : `${month} ${day}`;
  }
  return locale === 'ru'
    ? `${day} ${month} ${d.getFullYear()} г.`
    : `${month} ${day}, ${d.getFullYear()}`;
}

function utcYesterday(date: Date): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1),
  ).toISOString().slice(0, 10);
}

/** Ledger rows added later can belong to an earlier UTC banking date. */
export function transactionDayKey(transaction: Transaction): string {
  return transaction.effectiveDate ?? dayKey(transaction.createdAt);
}

/** Format an explicit banking date without letting the viewer timezone shift it. */
export function fmtTransactionDay(
  transaction: Transaction,
  locale: AppLocale = 'ru',
  now = new Date(),
): string {
  if (transaction.effectiveDate === undefined) {
    return fmtDay(transaction.createdAt, locale, now);
  }
  const date = transaction.effectiveDate;
  if (date === now.toISOString().slice(0, 10)) return translate(locale, 'date.today');
  if (date === utcYesterday(now)) return translate(locale, 'date.yesterday');
  const [year, month, day] = date.split('-').map(Number);
  const monthName = MONTH_NAMES[locale][month - 1];
  if (year === now.getUTCFullYear()) {
    return locale === 'ru' ? `${day} ${monthName}` : `${monthName} ${day}`;
  }
  return locale === 'ru'
    ? `${day} ${monthName} ${year} г.`
    : `${monthName} ${day}, ${year}`;
}

export function fmtRateDate(
  asOf: string,
  locale: AppLocale,
  style: 'short' | 'full' = 'short',
): string {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  return RATE_DATE_FORMATTERS[locale][style].format(date);
}

/** Local YYYY-MM-DD — stable grouping key. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CATEGORY_KEYS: Readonly<Record<string, TranslationKey>> = {
  groceries: 'category.groceries',
  transport: 'category.transport',
  coffee: 'category.coffee',
  food: 'category.food',
  shopping: 'category.shopping',
  health: 'category.health',
  entertainment: 'category.entertainment',
  home: 'category.home',
  salary: 'category.salary',
  subscriptions: 'category.subscriptions',
  transfer: 'category.transfer',
  interest: 'category.interest',
  other: 'category.other',
};

export function categoryLabel(category: string | undefined, locale: AppLocale): string {
  const categoryKey = category ?? 'other';
  const translationKey = Object.hasOwn(CATEGORY_KEYS, categoryKey)
    ? CATEGORY_KEYS[categoryKey]
    : 'category.other';
  return translate(locale, translationKey);
}

const ENGLISH_DEMO_TEXT: Readonly<Record<string, string>> = {
  'Текущий': 'Current',
  'Накопительный': 'Savings',
  'Рубли': 'Ruble account',
  'Доллары': 'US dollar account',
  'Евро': 'Euro account',
  'Баты': 'Baht account',
  'Донги': 'Dong account',
  'Рупии': 'Rupiah account',
  'Лари': 'Lari account',
  'Начальный баланс': 'Opening balance',
  'Пополнение с внешнего счёта': 'External top-up',
  'Перевод контакту': 'Transfer to contact',
  'В прежний накопительный': 'To previous savings',
  'Из прежнего накопительного': 'From previous savings',
  'Снятие наличных': 'Cash withdrawal',
  'Комиссия банка': 'Bank fee',
  'Сверка итогового баланса': 'Statement balance reconciliation',
  'Резерв на расходы': 'Spending reserve',
  'Проценты по счёту': 'Account interest',
  'ТОО «Орбита Лабс»': 'Orbita Labs LLP',
  'Аренда квартиры': 'Rent',
  'Городское такси': 'City Taxi',
  'Магазин у дома': 'Corner Store',
  'Зелёный базар': 'Green Bazaar',
  'Доставка продуктов': 'Grocery Delivery',
  'Гипермаркет': 'Hypermarket',
  'Кофейня на Абая': 'Abai Coffee',
  'Кофейня у парка': 'Park Café',
  'Доставка еды': 'Food Delivery',
  'Городская столовая': 'City Canteen',
  'Маркетплейс': 'Marketplace',
  'Магазин одежды': 'Clothing Store',
  'Аптека у дома': 'Local Pharmacy',
  'ЖД билеты': 'Train Tickets',
  'Кинотеатр': 'Cinema',
  'Музыка': 'Music',
  'Онлайн-кинотеатр': 'Streaming Service',
  'Айдана': 'Aidana',
  'Данияр': 'Daniyar',
  'Апа': 'Mum',
  'Руслан': 'Ruslan',
  'Ержан': 'Yerzhan',
  'Жанна': 'Zhanna',
  'Полина': 'Polina',
  'Арман': 'Arman',
  'Никита': 'Nikita',
};

const RUSSIAN_DEMO_TEXT: Readonly<Record<string, string>> = {
  Current: 'Текущий',
  Savings: 'Накопительный',
  'Opening balance': 'Начальный баланс',
  'External account top up': 'Пополнение с внешнего счёта',
  'Balance correction': 'Корректировка баланса',
  'Account opened': 'Счёт открыт',
};

/** Translate only deterministic demo fixtures; unknown real user data stays byte-for-byte intact. */
export function localizeDemoText(value: string | undefined, locale: AppLocale): string {
  if (value === undefined) return '';
  const catalog = locale === 'en' ? ENGLISH_DEMO_TEXT : RUSSIAN_DEMO_TEXT;
  return Object.hasOwn(catalog, value) ? catalog[value] : value;
}

export type OwnTransferCounterpartIndex = ReadonlyMap<string, Account>;

/** Build both transfer-leg lookups in O(accounts + transactions). */
export function buildOwnTransferCounterpartIndex(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): OwnTransferCounterpartIndex {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const legsByGroup = new Map<
    string,
    { outgoing?: Transaction; incoming?: Transaction }
  >();
  for (const transaction of transactions) {
    if (transaction.transferGroupId === undefined) continue;
    if (transaction.kind !== 'transfer_own_out' && transaction.kind !== 'transfer_own_in') {
      continue;
    }
    const legs = legsByGroup.get(transaction.transferGroupId) ?? {};
    if (transaction.kind === 'transfer_own_out') {
      if (legs.outgoing === undefined) legs.outgoing = transaction;
    } else if (legs.incoming === undefined) {
      legs.incoming = transaction;
    }
    legsByGroup.set(transaction.transferGroupId, legs);
  }

  const counterpartByTransactionId = new Map<string, Account>();
  for (const legs of legsByGroup.values()) {
    if (legs.outgoing === undefined || legs.incoming === undefined) continue;
    const sourceAccount = accountById.get(legs.outgoing.accountId);
    const targetAccount = accountById.get(legs.incoming.accountId);
    if (targetAccount !== undefined) {
      counterpartByTransactionId.set(legs.outgoing.id, targetAccount);
    }
    if (sourceAccount !== undefined) {
      counterpartByTransactionId.set(legs.incoming.id, sourceAccount);
    }
  }
  return counterpartByTransactionId;
}

/** Manual transaction counterparties are user text, even when they collide with fixture copy. */
export function transactionCounterpartyDisplayName(
  transaction: Transaction,
  locale: AppLocale,
  ownTransferCounterparts?: OwnTransferCounterpartIndex,
): string {
  if (transaction.counterparty === undefined) return '';
  if (transaction.kind === 'manual_income' || transaction.kind === 'manual_expense') {
    return transaction.counterparty;
  }
  if (
    transaction.transferGroupId !== undefined &&
    (transaction.kind === 'transfer_own_out' || transaction.kind === 'transfer_own_in')
  ) {
    const counterpartAccount = ownTransferCounterparts?.get(transaction.id);
    if (counterpartAccount !== undefined) return accountDisplayName(counterpartAccount, locale);
  }
  return localizeDemoText(transaction.counterparty, locale);
}

/** Stable role-aware account label; user-created names outside our template stay untouched. */
export function accountDisplayName(account: Account, locale: AppLocale): string {
  if (account.role === 'primary-checking') return locale === 'ru' ? 'Текущий' : 'Current';
  if (account.role === 'primary-savings') return locale === 'ru' ? 'Накопительный' : 'Savings';
  if (account.role === 'companion-1' || account.role === 'companion-2') {
    return currencyName(locale, account.currency);
  }
  if (account.name === `Everyday ${account.currency}`) {
    return locale === 'ru' ? 'Повседневный' : 'Everyday';
  }
  return account.name;
}

export function shouldShowTransactionTime(transaction: Transaction): boolean {
  if (transaction.effectiveDate === undefined) return true;
  return transaction.effectiveDate === new Date(transaction.createdAt).toISOString().slice(0, 10);
}

/** "40817810200001548753" → "4081 7810 2000 0154 8753" */
export function groupDigits(number: string): string {
  return number.replace(/(.{4})/g, '$1 ').trim();
}
