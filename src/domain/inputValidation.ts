export const DISALLOWED_USER_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SPACE_SEPARATORS = /\p{Z}+/gu;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  );
}

export function utcDate(iso: string): string {
  if (!isIsoTimestamp(iso)) throw new RangeError('Timestamp must be an ISO instant');
  return new Date(iso).toISOString().slice(0, 10);
}

export function normalizeUserText(
  value: string,
  maxCodePoints: number,
  allowEmpty = false,
): string | null {
  const normalized = value.normalize('NFC').replace(SPACE_SEPARATORS, ' ').trim();
  if ((!allowEmpty && normalized.length === 0) || [...normalized].length > maxCodePoints) return null;
  if (DISALLOWED_USER_TEXT.test(normalized)) return null;
  return normalized;
}

export function isAllowedEffectiveDate(value: string, nowISO: string): boolean {
  if (!isIsoDate(value) || !isIsoTimestamp(nowISO)) return false;
  const today = utcDate(nowISO);
  const oldest = new Date(`${today}T00:00:00.000Z`);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 10);
  return value >= oldest.toISOString().slice(0, 10) && value <= today;
}

export function monthOccurrence(year: number, month: number, anchorDay: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(anchorDay) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    anchorDay < 1 ||
    anchorDay > 31
  ) {
    return null;
  }
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(anchorDay, days)).padStart(2, '0')}`;
}

export function nextMonthOccurrence(date: string, anchorDay: number): string | null {
  if (!isIsoDate(date)) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12
    ? monthOccurrence(year + 1, 1, anchorDay)
    : monthOccurrence(year, month + 1, anchorDay);
}
