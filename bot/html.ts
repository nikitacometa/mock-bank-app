const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
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
  if (CONTROL_CHARACTERS.test(value)) return null;
  const normalized = value.normalize('NFC').trim().replace(/\p{Z}+/gu, ' ');
  if (
    normalized === '' ||
    [...normalized].length > MAX_DISPLAY_NAME_CODE_POINTS
  ) {
    return null;
  }
  return normalized;
}

export function telegramDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
  fallback: string,
): string {
  const joined = [firstName, lastName].filter((part): part is string => part !== undefined).join(' ');
  return normalizeDisplayName(joined) ?? fallback;
}
