import {
  DISALLOWED_USER_TEXT,
  normalizeUserText,
} from '../src/domain/inputValidation.js';

const MAX_DISPLAY_NAME_CODE_POINTS = 48;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeDisplayName(value: string): string | null {
  if (DISALLOWED_USER_TEXT.test(value)) return null;
  return normalizeUserText(value, MAX_DISPLAY_NAME_CODE_POINTS);
}

export function telegramDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
  fallback: string,
): string {
  const joined = [firstName, lastName].filter((part): part is string => part !== undefined).join(' ');
  return normalizeDisplayName(joined) ?? fallback;
}
