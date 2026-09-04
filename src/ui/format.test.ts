import { describe, expect, it } from 'vitest';
import { categoryLabel, fmtDay, fmtRateDate, fmtTime, localizeDemoText } from './format';

describe('localized UI formatting', () => {
  it('formats relative and calendar days in both interface languages', () => {
    const now = new Date('2026-09-02T12:00:00');
    expect(fmtDay('2026-09-02T08:00:00', 'ru', now)).toBe('Сегодня');
    expect(fmtDay('2026-09-02T08:00:00', 'en', now)).toBe('Today');
    expect(fmtDay('2026-09-01T08:00:00', 'en', now)).toBe('Yesterday');
    expect(fmtDay('2026-08-31T08:00:00', 'en', now)).toBe('August 31');
  });

  it('formats immutable provider dates in UTC without a timezone day shift', () => {
    expect(fmtRateDate('2026-09-01', 'ru')).toContain('1');
    expect(fmtRateDate('2026-09-01', 'en')).toBe('Sep 1');
    expect(fmtRateDate('2026-09-01', 'en', 'full')).toBe('09/01/2026');
  });

  it('uses calendar-day arithmetic across daylight-saving transitions', () => {
    const now = new Date(2026, 2, 9, 0, 30);
    const previousCalendarDay = new Date(2026, 2, 8, 23, 30);

    expect(fmtDay(previousCalendarDay.toISOString(), 'en', now)).toBe('Yesterday');
  });

  it('formats transaction time for the selected interface locale', () => {
    const localTime = new Date(2026, 8, 1, 18, 5).toISOString();

    expect(fmtTime(localTime, 'ru')).toBe('18:05');
    expect(fmtTime(localTime, 'en')).toBe('6:05 PM');
  });

  it('tracks a runtime device time-zone change without stale formatter state', () => {
    const environment = (
      globalThis as typeof globalThis & {
        process?: { env: Record<string, string | undefined> };
      }
    ).process?.env;
    if (environment === undefined) throw new Error('test runtime has no process environment');
    const originalTimeZone = environment.TZ;
    try {
      environment.TZ = 'UTC';
      expect(fmtTime('2026-09-01T12:34:00.000Z', 'en')).toBe('12:34 PM');

      environment.TZ = 'America/New_York';
      expect(fmtTime('2026-09-01T12:34:00.000Z', 'en')).toBe('8:34 AM');
    } finally {
      if (originalTimeZone === undefined) delete environment.TZ;
      else environment.TZ = originalTimeZone;
    }
  });

  it('localizes category and known demo data while preserving unknown user text', () => {
    expect(categoryLabel('groceries', 'en')).toBe('Groceries');
    expect(categoryLabel('constructor', 'en')).toBe('Other');
    expect(localizeDemoText('Городское такси', 'en')).toBe('City Taxi');
    expect(localizeDemoText('Сверка итогового баланса', 'en')).toBe(
      'Statement balance reconciliation',
    );
    expect(localizeDemoText('Custom Merchant', 'en')).toBe('Custom Merchant');
    expect(localizeDemoText('constructor', 'en')).toBe('constructor');
    expect(localizeDemoText('Городское такси', 'ru')).toBe('Городское такси');
  });
});
