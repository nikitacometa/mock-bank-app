const LEDGER_RECEIPT_VERSION = 1;
const RETIRED_EPOCH_CAP = 8;
const TELEGRAM_USER_NAMESPACE_PREFIX = 'cometa.bank.tma.user.';

const TELEGRAM_ID_PATTERN = /^[1-9]\d{0,19}$/;
const REVISION_EPOCH_PATTERN = /^[0-9a-f]{32}$/;
const STATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface LedgerAuthorityMarker {
  readonly version: typeof LEDGER_RECEIPT_VERSION;
  readonly mode: 'server';
  readonly telegramId: string;
}

export interface LedgerAuthorityRevision {
  readonly telegramId: string;
  readonly revisionEpoch: string;
  readonly revision: number;
  readonly digest: string;
}

export interface LedgerAuthorityReceipt extends LedgerAuthorityRevision {
  readonly version: typeof LEDGER_RECEIPT_VERSION;
  readonly mode: 'server';
  readonly retiredRevisionEpochs: readonly string[];
}

export type LedgerRevisionDecision =
  | 'newer'
  | 'current'
  | 'stale'
  | 'digest_conflict'
  | 'retired_epoch'
  | 'wrong_user';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalTelegramId(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_ID_PATTERN.test(value);
}

function isRevisionEpoch(value: unknown): value is string {
  return typeof value === 'string' && REVISION_EPOCH_PATTERN.test(value);
}

function isStateDigest(value: unknown): value is string {
  return typeof value === 'string' && STATE_DIGEST_PATTERN.test(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function receiptKey(telegramId: string): string {
  return `${TELEGRAM_USER_NAMESPACE_PREFIX}${telegramId}.ledger-authority-receipt`;
}

function markerKey(telegramId: string): string {
  return `${TELEGRAM_USER_NAMESPACE_PREFIX}${telegramId}.ledger-authority-mode`;
}

function parseLedgerAuthorityMarker(value: unknown): LedgerAuthorityMarker | null {
  if (
    !isRecord(value) ||
    value.version !== LEDGER_RECEIPT_VERSION ||
    value.mode !== 'server' ||
    !isCanonicalTelegramId(value.telegramId)
  ) {
    return null;
  }
  return {
    version: LEDGER_RECEIPT_VERSION,
    mode: 'server',
    telegramId: value.telegramId,
  };
}

export function parseLedgerAuthorityRevision(
  value: unknown,
): LedgerAuthorityRevision | null {
  if (
    !isRecord(value) ||
    !isCanonicalTelegramId(value.telegramId) ||
    !isRevisionEpoch(value.revisionEpoch) ||
    !isRevision(value.revision) ||
    !isStateDigest(value.digest)
  ) {
    return null;
  }
  return {
    telegramId: value.telegramId,
    revisionEpoch: value.revisionEpoch,
    revision: value.revision,
    digest: value.digest,
  };
}

export function parseLedgerAuthorityReceipt(
  value: unknown,
): LedgerAuthorityReceipt | null {
  const revision = parseLedgerAuthorityRevision(value);
  if (
    revision === null ||
    !isRecord(value) ||
    value.version !== LEDGER_RECEIPT_VERSION ||
    value.mode !== 'server' ||
    !Array.isArray(value.retiredRevisionEpochs) ||
    value.retiredRevisionEpochs.length > RETIRED_EPOCH_CAP ||
    !value.retiredRevisionEpochs.every(isRevisionEpoch) ||
    new Set(value.retiredRevisionEpochs).size !== value.retiredRevisionEpochs.length ||
    value.retiredRevisionEpochs.includes(revision.revisionEpoch)
  ) {
    return null;
  }
  return {
    version: LEDGER_RECEIPT_VERSION,
    mode: 'server',
    ...revision,
    retiredRevisionEpochs: [...value.retiredRevisionEpochs],
  };
}

export function loadLedgerAuthorityReceipt(
  telegramId: string,
): LedgerAuthorityReceipt | null {
  if (!isCanonicalTelegramId(telegramId)) return null;
  try {
    const raw = localStorage.getItem(receiptKey(telegramId));
    if (raw === null) return null;
    const receipt = parseLedgerAuthorityReceipt(JSON.parse(raw) as unknown);
    return receipt?.telegramId === telegramId ? receipt : null;
  } catch {
    return null;
  }
}

export function hasStickyServerLedgerMode(telegramId: string): boolean {
  if (!isCanonicalTelegramId(telegramId)) return false;
  try {
    const raw = localStorage.getItem(markerKey(telegramId));
    if (raw === null) return false;
    return parseLedgerAuthorityMarker(JSON.parse(raw) as unknown)?.telegramId === telegramId;
  } catch {
    return false;
  }
}

/**
 * Persist before the first import request. If its response is lost after the
 * server commits, a later launch must still refuse client-local mutations.
 */
export function markStickyServerLedgerMode(telegramId: string): boolean {
  if (!isCanonicalTelegramId(telegramId)) return false;
  const marker: LedgerAuthorityMarker = {
    version: LEDGER_RECEIPT_VERSION,
    mode: 'server',
    telegramId,
  };
  try {
    localStorage.setItem(markerKey(telegramId), JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

export function saveLedgerAuthorityReceipt(receipt: LedgerAuthorityReceipt): boolean {
  const canonical = parseLedgerAuthorityReceipt(receipt);
  if (canonical === null) return false;
  try {
    localStorage.setItem(receiptKey(canonical.telegramId), JSON.stringify(canonical));
    return true;
  } catch {
    return false;
  }
}

export function classifyLedgerAuthorityRevision(
  receipt: LedgerAuthorityReceipt | null,
  candidate: LedgerAuthorityRevision,
): LedgerRevisionDecision {
  if (receipt === null) return 'newer';
  if (receipt.telegramId !== candidate.telegramId) return 'wrong_user';
  if (receipt.retiredRevisionEpochs.includes(candidate.revisionEpoch)) return 'retired_epoch';
  if (receipt.revisionEpoch !== candidate.revisionEpoch) return 'newer';
  if (candidate.revision < receipt.revision) return 'stale';
  if (candidate.revision > receipt.revision) return 'newer';
  return candidate.digest === receipt.digest ? 'current' : 'digest_conflict';
}

export function advanceLedgerAuthorityReceipt(
  receipt: LedgerAuthorityReceipt | null,
  candidate: LedgerAuthorityRevision,
): LedgerAuthorityReceipt | null {
  const decision = classifyLedgerAuthorityRevision(receipt, candidate);
  if (decision === 'current') return receipt;
  if (decision !== 'newer') return null;

  const retiredRevisionEpochs = receipt === null
    ? []
    : receipt.revisionEpoch === candidate.revisionEpoch
      ? [...receipt.retiredRevisionEpochs]
      : [...receipt.retiredRevisionEpochs, receipt.revisionEpoch].slice(-RETIRED_EPOCH_CAP);
  return {
    version: LEDGER_RECEIPT_VERSION,
    mode: 'server',
    ...candidate,
    retiredRevisionEpochs,
  };
}

export function ledgerAuthorityReceiptStorageKeyForTest(telegramId: string): string | null {
  return isCanonicalTelegramId(telegramId) ? receiptKey(telegramId) : null;
}

export function ledgerAuthorityMarkerStorageKeyForTest(telegramId: string): string | null {
  return isCanonicalTelegramId(telegramId) ? markerKey(telegramId) : null;
}
