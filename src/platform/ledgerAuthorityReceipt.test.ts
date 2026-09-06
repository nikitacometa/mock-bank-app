import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceLedgerAuthorityReceipt,
  classifyLedgerAuthorityRevision,
  hasStickyServerLedgerMode,
  ledgerAuthorityMarkerStorageKeyForTest,
  ledgerAuthorityReceiptStorageKeyForTest,
  loadLedgerAuthorityReceipt,
  parseLedgerAuthorityReceipt,
  markStickyServerLedgerMode,
  saveLedgerAuthorityReceipt,
  type LedgerAuthorityReceipt,
  type LedgerAuthorityRevision,
} from './ledgerAuthorityReceipt';

const USER_A = '9007199254740993';
const USER_B = '9007199254740995';
const EPOCH_A = 'a'.repeat(32);
const EPOCH_B = 'b'.repeat(32);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);

function revision(
  values: Partial<LedgerAuthorityRevision> = {},
): LedgerAuthorityRevision {
  return {
    telegramId: USER_A,
    revisionEpoch: EPOCH_A,
    revision: 4,
    digest: DIGEST_A,
    ...values,
  };
}

function receipt(
  values: Partial<LedgerAuthorityReceipt> = {},
): LedgerAuthorityReceipt {
  return {
    version: 1,
    mode: 'server',
    retiredRevisionEpochs: [],
    ...revision(),
    ...values,
  };
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  });
});

describe('ledger authority receipt', () => {
  it('keeps sticky server receipts isolated by canonical Telegram ID', () => {
    const receiptA = receipt();
    const receiptB = receipt({ telegramId: USER_B, digest: DIGEST_B });

    expect(saveLedgerAuthorityReceipt(receiptA)).toBe(true);
    expect(saveLedgerAuthorityReceipt(receiptB)).toBe(true);

    expect(loadLedgerAuthorityReceipt(USER_A)).toEqual(receiptA);
    expect(loadLedgerAuthorityReceipt(USER_B)).toEqual(receiptB);
    expect(ledgerAuthorityReceiptStorageKeyForTest(USER_A)).not.toBe(
      ledgerAuthorityReceiptStorageKeyForTest(USER_B),
    );
  });

  it('writes a sticky per-user mode marker before a receipt exists', () => {
    expect(markStickyServerLedgerMode(USER_A)).toBe(true);

    expect(hasStickyServerLedgerMode(USER_A)).toBe(true);
    expect(hasStickyServerLedgerMode(USER_B)).toBe(false);
    expect(loadLedgerAuthorityReceipt(USER_A)).toBeNull();
    expect(ledgerAuthorityMarkerStorageKeyForTest(USER_A)).not.toBe(
      ledgerAuthorityMarkerStorageKeyForTest(USER_B),
    );
  });

  it('rejects stale revisions and equal-revision digest mismatches', () => {
    const current = receipt();

    expect(classifyLedgerAuthorityRevision(current, revision({ revision: 3 }))).toBe('stale');
    expect(classifyLedgerAuthorityRevision(current, revision({ digest: DIGEST_B }))).toBe(
      'digest_conflict',
    );
    expect(classifyLedgerAuthorityRevision(current, revision())).toBe('current');
    expect(classifyLedgerAuthorityRevision(current, revision({ revision: 5 }))).toBe('newer');
  });

  it('retires an old epoch so a delayed response cannot restore it', () => {
    const oldReceipt = receipt();
    const newRevision = revision({
      revisionEpoch: EPOCH_B,
      revision: 1,
      digest: DIGEST_B,
    });
    const advanced = advanceLedgerAuthorityReceipt(oldReceipt, newRevision);

    expect(advanced).toEqual(
      receipt({
        revisionEpoch: EPOCH_B,
        revision: 1,
        digest: DIGEST_B,
        retiredRevisionEpochs: [EPOCH_A],
      }),
    );
    expect(classifyLedgerAuthorityRevision(advanced, revision())).toBe('retired_epoch');
    expect(advanceLedgerAuthorityReceipt(advanced, revision())).toBeNull();
  });

  it('strictly rejects malformed or over-broad persisted receipts', () => {
    expect(parseLedgerAuthorityReceipt({ ...receipt(), extra: 'ignored' })).toEqual(receipt());
    expect(parseLedgerAuthorityReceipt({ ...receipt(), revision: 1.5 })).toBeNull();
    expect(parseLedgerAuthorityReceipt({ ...receipt(), digest: 'A'.repeat(64) })).toBeNull();
    expect(parseLedgerAuthorityReceipt({ ...receipt(), telegramId: '01' })).toBeNull();
    expect(
      parseLedgerAuthorityReceipt({
        ...receipt(),
        retiredRevisionEpochs: Array.from({ length: 9 }, (_, index) =>
          index.toString(16).padStart(32, '0'),
        ),
      }),
    ).toBeNull();
  });
});
