const CLIENT_CONTRACT_MARKER_VERSION = 1;
const BANK_CONTRACT_VERSION = 1;
const TELEGRAM_USER_NAMESPACE_PREFIX = 'cometa.bank.tma.user.';
const TELEGRAM_ID_PATTERN = /^[1-9]\d{0,19}$/;
const RELEASE_ID_PATTERN = /^(?:development|\d{8}T\d{6}Z)$/;

export interface LedgerClientContractMarker {
  readonly version: typeof CLIENT_CONTRACT_MARKER_VERSION;
  readonly bankContractVersion: typeof BANK_CONTRACT_VERSION;
  readonly telegramId: string;
  readonly releaseId: string;
}

function markerKey(telegramId: string): string {
  return `${TELEGRAM_USER_NAMESPACE_PREFIX}${telegramId}.ledger-client-contract`;
}

function releaseIdFromBuild(): string {
  const candidate = import.meta.env.VITE_COMETA_RELEASE_ID;
  return typeof candidate === 'string' && RELEASE_ID_PATTERN.test(candidate)
    ? candidate
    : 'development';
}

function parseMarker(value: unknown): LedgerClientContractMarker | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) return null;
  const marker = value as Record<string, unknown>;
  if (
    marker.version !== CLIENT_CONTRACT_MARKER_VERSION ||
    marker.bankContractVersion !== BANK_CONTRACT_VERSION ||
    typeof marker.telegramId !== 'string' ||
    !TELEGRAM_ID_PATTERN.test(marker.telegramId) ||
    typeof marker.releaseId !== 'string' ||
    !RELEASE_ID_PATTERN.test(marker.releaseId)
  ) return null;
  return {
    version: CLIENT_CONTRACT_MARKER_VERSION,
    bankContractVersion: BANK_CONTRACT_VERSION,
    telegramId: marker.telegramId,
    releaseId: marker.releaseId,
  };
}

/** Persist proof that this verified Telegram profile ran the authority-capable client. */
export function markLedgerClientContract(telegramId: string): boolean {
  if (!TELEGRAM_ID_PATTERN.test(telegramId)) return false;
  const marker: LedgerClientContractMarker = {
    version: CLIENT_CONTRACT_MARKER_VERSION,
    bankContractVersion: BANK_CONTRACT_VERSION,
    telegramId,
    releaseId: releaseIdFromBuild(),
  };
  try {
    localStorage.setItem(markerKey(telegramId), JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

export function loadLedgerClientContract(
  telegramId: string,
): LedgerClientContractMarker | null {
  if (!TELEGRAM_ID_PATTERN.test(telegramId)) return null;
  try {
    const raw = localStorage.getItem(markerKey(telegramId));
    if (raw === null) return null;
    const marker = parseMarker(JSON.parse(raw) as unknown);
    return marker?.telegramId === telegramId ? marker : null;
  } catch {
    return null;
  }
}

export function ledgerClientContractStorageKeyForTest(telegramId: string): string | null {
  return TELEGRAM_ID_PATTERN.test(telegramId) ? markerKey(telegramId) : null;
}
