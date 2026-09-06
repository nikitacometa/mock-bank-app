import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ledgerClientContractStorageKeyForTest,
  loadLedgerClientContract,
  markLedgerClientContract,
} from './ledgerClientContract';

describe('Telegram ledger client contract marker', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('persists an exact per-profile marker for the authority-capable build', () => {
    expect(markLedgerClientContract('9007199254740993')).toBe(true);
    expect(loadLedgerClientContract('9007199254740993')).toEqual({
      version: 1,
      bankContractVersion: 1,
      telegramId: '9007199254740993',
      releaseId: 'development',
    });
    expect(loadLedgerClientContract('42')).toBeNull();
  });

  it('rejects malformed identities, corrupted markers, and failed writes', () => {
    expect(markLedgerClientContract('0')).toBe(false);
    const key = ledgerClientContractStorageKeyForTest('42');
    if (key === null) throw new Error('test identity must be valid');
    storage.set(key, JSON.stringify({
      version: 1,
      bankContractVersion: 1,
      telegramId: '43',
      releaseId: 'development',
    }));
    expect(loadLedgerClientContract('42')).toBeNull();
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(markLedgerClientContract('42')).toBe(false);
  });

  it('records the immutable production release ID', () => {
    vi.stubEnv('VITE_COMETA_RELEASE_ID', '20260905T120000Z');

    expect(markLedgerClientContract('42')).toBe(true);
    expect(loadLedgerClientContract('42')?.releaseId).toBe('20260905T120000Z');
  });
});
