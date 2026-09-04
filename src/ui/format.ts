import { translate, type AppLocale, type TranslationKey } from '@/i18n';

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

/** Translate only deterministic demo fixtures; unknown real user data stays byte-for-byte intact. */
export function localizeDemoText(value: string | undefined, locale: AppLocale): string {
  if (value === undefined) return '';
  return locale === 'en' && Object.hasOwn(ENGLISH_DEMO_TEXT, value)
    ? ENGLISH_DEMO_TEXT[value]
    : value;
}

/** "40817810200001548753" → "4081 7810 2000 0154 8753" */
export function groupDigits(number: string): string {
  return number.replace(/(.{4})/g, '$1 ').trim();
}
