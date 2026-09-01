const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function fmtDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameLocalDay(d, now)) return 'Сегодня';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameLocalDay(d, yesterday)) return 'Вчера';
  const base = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Local YYYY-MM-DD — stable grouping key. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'Продукты',
  transport: 'Транспорт',
  coffee: 'Кофе',
  food: 'Еда',
  shopping: 'Покупки',
  health: 'Аптека',
  entertainment: 'Развлечения',
  home: 'Дом',
  salary: 'Зарплата',
  subscriptions: 'Подписки',
  transfer: 'Перевод',
  interest: 'Проценты',
  other: 'Другое',
};

/** "40817810200001548753" → "4081 7810 2000 0154 8753" */
export function groupDigits(number: string): string {
  return number.replace(/(.{4})/g, '$1 ').trim();
}
