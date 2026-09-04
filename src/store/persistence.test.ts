import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSeed } from '@/domain/seed';
import { applyTransfer } from '@/domain/transfer';
import {
  loadAppliedLaunchPreferencesReceipt,
  loadLocalePreference,
  loadPersisted,
  onLocalePreferenceChange,
  saveAppliedLaunchPreferencesReceipt,
  saveLocalePreference,
  SCHEMA_VERSION,
  withPersistenceLock,
  type AppliedLaunchPreferencesReceipt,
} from './persistence';

const NOW = '2026-09-01T12:00:00.000Z';

type MutableRecord = Record<string, unknown>;

function mutableState(): MutableRecord {
  return JSON.parse(JSON.stringify(buildSeed(NOW))) as MutableRecord;
}

function mutableFxState(): MutableRecord {
  const outcome = applyTransfer(buildSeed(NOW), {
    fromAccountId: 'acc_checking',
    toAccountId: 'acc_usd',
    amountMinor: 10_000,
    clientTransferId: 'ct_persistence_fx',
    nowISO: NOW,
  });
  if (!outcome.ok) throw new Error(`FX fixture failed: ${outcome.error}`);
  return JSON.parse(JSON.stringify(outcome.state)) as MutableRecord;
}

function records(state: MutableRecord, key: string): MutableRecord[] {
  const value = state[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not an array in the test fixture`);
  return value as MutableRecord[];
}

function storedEnvelope(state: unknown, schemaVersion = SCHEMA_VERSION): string {
  return JSON.stringify({ schemaVersion, state });
}

function loadRaw(raw: string | null, getError?: Error) {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => {
      if (getError) throw getError;
      return raw;
    }),
  });
  return loadPersisted();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loadPersisted', () => {
  it('accepts a complete valid BankState', () => {
    const state = buildSeed(NOW);

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'ok', state });
  });

  it('rejects schema v3 so the pre-statement demo is reseeded', () => {
    expect(loadRaw(storedEnvelope(buildSeed(NOW), 3))).toEqual({ kind: 'corrupted' });
  });

  it('accepts the bundled fallback snapshot when the device clock predates its build date', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T12:00:00.000Z');
    const state = buildSeed('2026-08-20T12:00:00.000Z');

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'ok', state });
  });

  it('strips extra persisted store keys from the loaded BankState projection', () => {
    const state = mutableState();
    state.settleNow = 'replace the store action';
    state.ratesStatus = 'error';

    const result = loadRaw(storedEnvelope(state));

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('valid persisted state was rejected');
    expect(Object.keys(result.state)).toEqual([
      'primaryCurrency',
      'exchangeRates',
      'accounts',
      'transactions',
      'cards',
      'contacts',
      'profile',
      'nextSeq',
      'recentTransferIds',
    ]);
    expect(result.state).toEqual(buildSeed(NOW));
    expect('settleNow' in result.state).toBe(false);
    expect('ratesStatus' in result.state).toBe(false);
  });

  it('keeps an unavailable or empty storage in in-memory mode', () => {
    expect(loadRaw(null)).toEqual({ kind: 'empty' });
    expect(loadRaw(null, new Error('storage disabled'))).toEqual({ kind: 'empty' });
  });

  it.each([
    ['truncated JSON', '{"schemaVersion":'],
    ['null envelope', 'null'],
    ['array envelope', '[]'],
    ['missing state', JSON.stringify({ schemaVersion: SCHEMA_VERSION })],
    ['wrong schema version', storedEnvelope(mutableState(), SCHEMA_VERSION + 1)],
  ])('rejects %s', (_case, raw) => {
    expect(loadRaw(raw)).toEqual({ kind: 'corrupted' });
  });

  it('rejects every missing top-level BankState field', () => {
    for (const field of [
      'primaryCurrency',
      'exchangeRates',
      'accounts',
      'transactions',
      'cards',
      'contacts',
      'profile',
      'nextSeq',
      'recentTransferIds',
    ]) {
      const state = mutableState();
      delete state[field];

      expect(loadRaw(storedEnvelope(state)), field).toEqual({ kind: 'corrupted' });
    }
  });

  it.each([
    ['account.createdAt', (state: MutableRecord) => delete records(state, 'accounts')[0].createdAt],
    ['transaction.kind', (state: MutableRecord) => delete records(state, 'transactions')[0].kind],
    ['card.status', (state: MutableRecord) => delete records(state, 'cards')[0].status],
    ['contact.initials', (state: MutableRecord) => delete records(state, 'contacts')[0].initials],
    [
      'profile.displayName',
      (state: MutableRecord) => delete (state.profile as MutableRecord).displayName,
    ],
  ])('rejects a missing nested field: %s', (_case, mutate) => {
    const state = mutableState();
    mutate(state);

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it.each([
    [
      'transaction account',
      (state: MutableRecord) => {
        records(state, 'transactions')[0].accountId = 'acc_missing';
      },
    ],
    [
      'card account',
      (state: MutableRecord) => {
        records(state, 'cards')[0].accountId = 'acc_missing';
      },
    ],
  ])('rejects a broken %s reference', (_case, mutate) => {
    const state = mutableState();
    mutate(state);

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it.each([
    [
      'nextSeq',
      (state: MutableRecord) => {
        state.nextSeq = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'transaction seq',
      (state: MutableRecord) => {
        records(state, 'transactions')[0].seq = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'amountMinor',
      (state: MutableRecord) => {
        records(state, 'transactions')[0].amountMinor = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'balanceAfterMinor',
      (state: MutableRecord) => {
        records(state, 'transactions')[0].balanceAfterMinor = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
  ])('rejects an unsafe integer in %s', (_case, mutate) => {
    const state = mutableState();
    mutate(state);

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it.each([
    [
      'account.createdAt',
      (state: MutableRecord) => {
        records(state, 'accounts')[0].createdAt = '2026-02-30T12:00:00.000Z';
      },
    ],
    [
      'account.accrualAnchor',
      (state: MutableRecord) => {
        records(state, 'accounts')[1].accrualAnchor = 'yesterday';
      },
    ],
    [
      'transaction.createdAt',
      (state: MutableRecord) => {
        records(state, 'transactions')[0].createdAt = '2026-09-01';
      },
    ],
    [
      'contact.lastTransferAt',
      (state: MutableRecord) => {
        records(state, 'contacts')[0].lastTransferAt = 'not-a-date';
      },
    ],
  ])('rejects an invalid ISO timestamp in %s', (_case, mutate) => {
    const state = mutableState();
    mutate(state);

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it('rejects invalid account, transaction, card, profile, and recent-transfer metadata', () => {
    const invalidStates = [
      (state: MutableRecord) => {
        records(state, 'accounts')[0].type = 'credit';
      },
      (state: MutableRecord) => {
        records(state, 'accounts')[0].currency = 'DOGE';
      },
      (state: MutableRecord) => {
        records(state, 'transactions')[0].status = 'settled';
      },
      (state: MutableRecord) => {
        records(state, 'cards')[0].last4 = '12345';
      },
      (state: MutableRecord) => {
        (state.profile as MutableRecord).displayName = '';
      },
      (state: MutableRecord) => {
        (state.profile as MutableRecord).displayName = `Nikita\nAdmin`;
      },
      (state: MutableRecord) => {
        (state.profile as MutableRecord).displayName = 'x'.repeat(49);
      },
      (state: MutableRecord) => {
        (state.profile as MutableRecord).telegramId = '1e9';
      },
      (state: MutableRecord) => {
        state.recentTransferIds = Array.from({ length: 51 }, (_, index) => `ct_${index}`);
      },
      (state: MutableRecord) => {
        state.recentTransferIds = ['ct_duplicate', 'ct_duplicate'];
      },
      (state: MutableRecord) => {
        state.recentTransferIds = [`ct_${'x'.repeat(97)}`];
      },
    ];

    for (const invalidate of invalidStates) {
      const state = mutableState();
      invalidate(state);

      expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
    }
  });

  it('rejects a finite APY that can overflow interest settlement', () => {
    const state = mutableState();
    const savings = records(state, 'accounts').find((account) => account.type === 'savings');
    if (!savings) throw new Error('seed has no savings account');
    savings.apy = Number.MAX_VALUE;

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it('rejects an accrual anchor before the account creation calendar date', () => {
    const beforeCreation = mutableState();
    const savings = records(beforeCreation, 'accounts').find(
      (account) => account.type === 'savings',
    );
    if (!savings || typeof savings.createdAt !== 'string') {
      throw new Error('seed has no savings account with a creation timestamp');
    }
    const creationDate = savings.createdAt.slice(0, 10);
    const previousDate = new Date(`${creationDate}T00:00:00.000Z`);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);
    savings.accrualAnchor = previousDate.toISOString();

    expect(loadRaw(storedEnvelope(beforeCreation))).toEqual({ kind: 'corrupted' });

    const sameDate = mutableState();
    const sameDateSavings = records(sameDate, 'accounts').find(
      (account) => account.type === 'savings',
    );
    if (!sameDateSavings || typeof sameDateSavings.createdAt !== 'string') {
      throw new Error('seed has no savings account with a creation timestamp');
    }
    sameDateSavings.accrualAnchor = `${sameDateSavings.createdAt.slice(0, 10)}T00:00:00.000Z`;

    expect(loadRaw(storedEnvelope(sameDate))).toEqual({ kind: 'ok', state: sameDate });
  });

  it('rejects backdated savings metadata when imminent settlement exceeds safe money', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const backdated = mutableState();
    const backdatedSavings = records(backdated, 'accounts').find(
      (account) => account.type === 'savings',
    );
    if (!backdatedSavings) throw new Error('seed has no savings account');
    backdatedSavings.createdAt = '0001-01-01T00:00:00.000Z';
    backdatedSavings.accrualAnchor = '0001-01-01T00:00:00.000Z';

    expect(loadRaw(storedEnvelope(backdated))).toEqual({ kind: 'corrupted' });

    const futureClock = mutableState();
    const futureSavings = records(futureClock, 'accounts').find(
      (account) => account.type === 'savings',
    );
    if (!futureSavings) throw new Error('seed has no savings account');
    futureSavings.accrualAnchor = '2026-09-02T00:00:00.000Z';

    expect(loadRaw(storedEnvelope(futureClock))).toEqual({ kind: 'ok', state: futureClock });
  });

  it('requires savings APY and accrual anchor as one complete pair', () => {
    for (const field of ['apy', 'accrualAnchor']) {
      const state = mutableState();
      const savings = records(state, 'accounts').find((account) => account.type === 'savings');
      if (!savings) throw new Error('seed has no savings account');
      delete savings[field];

      expect(loadRaw(storedEnvelope(state)), field).toEqual({ kind: 'corrupted' });
    }
  });

  it('rejects malformed exchange-rate metadata', () => {
    const invalidStates = [
      (state: MutableRecord) => {
        state.primaryCurrency = 'BTC';
      },
      (state: MutableRecord) => {
        (state.exchangeRates as MutableRecord).base = 'EUR';
      },
      (state: MutableRecord) => {
        (state.exchangeRates as MutableRecord).asOf = '2026-02-30';
      },
      (state: MutableRecord) => {
        (state.exchangeRates as MutableRecord).fetchedAt = 'today';
      },
      (state: MutableRecord) => {
        ((state.exchangeRates as MutableRecord).rates as MutableRecord).USD = '0';
      },
      (state: MutableRecord) => {
        delete ((state.exchangeRates as MutableRecord).rates as MutableRecord).GEL;
      },
      (state: MutableRecord) => {
        ((state.exchangeRates as MutableRecord).rates as MutableRecord).BTC = '1';
      },
    ];

    for (const invalidate of invalidStates) {
      const state = mutableState();
      invalidate(state);
      expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
    }
  });

  it('rejects stale or future-dated exchange-rate snapshots', () => {
    for (const asOf of ['2001-01-01', '2026-09-02']) {
      const state = mutableState();
      (state.exchangeRates as MutableRecord).asOf = asOf;

      expect(loadRaw(storedEnvelope(state)), asOf).toEqual({ kind: 'corrupted' });
    }
  });

  it('preserves a future-clock live snapshot until the store refreshes it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tooFarAhead = mutableState();
    const tooFarAheadRates = tooFarAhead.exchangeRates as MutableRecord;
    tooFarAheadRates.source = 'frankfurter';
    tooFarAheadRates.fetchedAt = '2026-09-01T12:05:01.000Z';

    expect(loadRaw(storedEnvelope(tooFarAhead))).toEqual({ kind: 'ok', state: tooFarAhead });

    const boundary = mutableState();
    const boundaryRates = boundary.exchangeRates as MutableRecord;
    boundaryRates.source = 'frankfurter';
    boundaryRates.fetchedAt = '2026-09-01T12:05:00.000Z';
    expect(loadRaw(storedEnvelope(boundary))).toEqual({ kind: 'ok', state: boundary });
  });

  it('rejects duplicate entity ids and a nextSeq that can collide', () => {
    const duplicateAccount = mutableState();
    records(duplicateAccount, 'accounts')[1].id = records(duplicateAccount, 'accounts')[0].id;
    expect(loadRaw(storedEnvelope(duplicateAccount))).toEqual({ kind: 'corrupted' });

    const collidingSeq = mutableState();
    const transactions = records(collidingSeq, 'transactions');
    collidingSeq.nextSeq = transactions.at(-1)?.seq;
    expect(loadRaw(storedEnvelope(collidingSeq))).toEqual({ kind: 'corrupted' });
  });

  it('rejects transaction and transfer-group ids reserved for a future sequence', () => {
    const futureTransactionId = mutableState();
    const transactions = records(futureTransactionId, 'transactions');
    transactions[0].id = `tx_${String(futureTransactionId.nextSeq)}`;
    expect(loadRaw(storedEnvelope(futureTransactionId))).toEqual({ kind: 'corrupted' });

    const futureGroupId = mutableState();
    const ownLeg = records(futureGroupId, 'transactions').find(
      (transaction) => transaction.kind === 'transfer_own_out',
    );
    if (!ownLeg || typeof ownLeg.transferGroupId !== 'string') {
      throw new Error('seed has no own-account transfer group');
    }
    const oldGroupId = ownLeg.transferGroupId;
    for (const transaction of records(futureGroupId, 'transactions')) {
      if (transaction.transferGroupId === oldGroupId) {
        transaction.transferGroupId = `grp_${String(futureGroupId.nextSeq)}`;
      }
    }
    expect(loadRaw(storedEnvelope(futureGroupId))).toEqual({ kind: 'corrupted' });
  });

  it('rejects a broken own-transfer pair', () => {
    const state = mutableState();
    const outgoing = records(state, 'transactions').find(
      (transaction) => transaction.kind === 'transfer_own_out',
    );
    if (!outgoing) throw new Error('seed has no own-account transfer');
    delete outgoing.transferGroupId;

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it('rejects inconsistent cross-currency FX legs', () => {
    const missingSnapshot = mutableFxState();
    const fxLegs = records(missingSnapshot, 'transactions').slice(-2);
    delete fxLegs[0].fxSnapshot;
    expect(loadRaw(storedEnvelope(missingSnapshot))).toEqual({ kind: 'corrupted' });

    const wrongAmount = mutableFxState();
    const incoming = records(wrongAmount, 'transactions').at(-1);
    if (!incoming) throw new Error('FX fixture has no incoming leg');
    (incoming.fxSnapshot as MutableRecord).toAmountMinor = Number(incoming.amountMinor) + 1;
    expect(loadRaw(storedEnvelope(wrongAmount))).toEqual({ kind: 'corrupted' });

    const wrongCurrency = mutableFxState();
    const outgoing = records(wrongCurrency, 'transactions').at(-2);
    if (!outgoing) throw new Error('FX fixture has no outgoing leg');
    (outgoing.fxSnapshot as MutableRecord).fromCurrency = 'EUR';
    expect(loadRaw(storedEnvelope(wrongCurrency))).toEqual({ kind: 'corrupted' });

    const forgedRate = mutableFxState();
    for (const leg of records(forgedRate, 'transactions').slice(-2)) {
      (leg.fxSnapshot as MutableRecord).rate = '999';
    }
    expect(loadRaw(storedEnvelope(forgedRate))).toEqual({ kind: 'corrupted' });
  });

  it('rejects historical FX metadata whose rate date is incoherent with fetch time', () => {
    const state = mutableFxState();
    for (const leg of records(state, 'transactions').slice(-2)) {
      (leg.fxSnapshot as MutableRecord).asOf = '2001-01-01';
    }

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it('rejects FX metadata on a non-own transaction', () => {
    const state = mutableFxState();
    const ownFx = records(state, 'transactions').at(-1)?.fxSnapshot;
    const purchase = records(state, 'transactions').find((transaction) => transaction.kind === 'purchase');
    if (!purchase || !ownFx) throw new Error('FX fixture is incomplete');
    purchase.fxSnapshot = ownFx;

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });

  it('rejects ledger balance drift', () => {
    const state = mutableState();
    const transaction = records(state, 'transactions')[0];
    transaction.balanceAfterMinor = Number(transaction.balanceAfterMinor) + 1;

    expect(loadRaw(storedEnvelope(state))).toEqual({ kind: 'corrupted' });
  });
});

describe('withPersistenceLock', () => {
  it('falls back only when lock acquisition fails and never retries entered work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fallbackWork = vi.fn(() => 'fallback');
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(async () => {
          throw new DOMException('storage access denied', 'SecurityError');
        }),
      },
    });

    await expect(withPersistenceLock(fallbackWork)).resolves.toBe('fallback');
    expect(fallbackWork).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[cometa] Web Locks unavailable; continuing without cross-tab serialization',
    );

    const transitionError = new Error('transition failed');
    const failingWork = vi.fn(() => {
      throw transitionError;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (_name: string, _options: LockOptions, callback: () => unknown) => callback(),
        ),
      },
    });

    await expect(withPersistenceLock(failingWork)).rejects.toBe(transitionError);
    expect(failingWork).toHaveBeenCalledOnce();
  });
});

describe('locale preference', () => {
  it('loads only a supported locale and otherwise defaults to Russian', () => {
    for (const [stored, expected] of [
      ['en', 'en'],
      ['ru', 'ru'],
      ['de', 'ru'],
      [null, 'ru'],
    ] as const) {
      vi.stubGlobal('localStorage', { getItem: vi.fn(() => stored) });
      expect(loadLocalePreference()).toBe(expected);
    }

    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new DOMException('storage denied', 'SecurityError');
      }),
    });
    expect(loadLocalePreference()).toBe('ru');
  });

  it('persists the locale separately from the bank-state envelope', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });

    expect(saveLocalePreference('en')).toBe(true);
    expect(setItem).toHaveBeenCalledWith('cometa.bank.locale', 'en');

    setItem.mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(saveLocalePreference('ru')).toBe(false);
  });

  it('syncs supported locale changes across tabs and treats removal as Russian', () => {
    let listener: ((event: StorageEvent) => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((_type: string, callback: (event: StorageEvent) => void) => {
        listener = callback;
      }),
      removeEventListener,
    });
    const callback = vi.fn();

    const dispose = onLocalePreferenceChange(callback);
    listener?.({ key: 'unrelated', newValue: 'en' } as StorageEvent);
    listener?.({ key: 'cometa.bank.locale', newValue: 'en' } as StorageEvent);
    listener?.({ key: 'cometa.bank.locale', newValue: null } as StorageEvent);
    dispose();

    expect(callback.mock.calls).toEqual([['en'], ['ru']]);
    expect(removeEventListener).toHaveBeenCalledWith('storage', listener);
  });
});

describe('Telegram launch preference receipt', () => {
  const receipt: AppliedLaunchPreferencesReceipt = {
    version: 2,
    bankSchemaVersion: SCHEMA_VERSION,
    telegramId: '42',
    revisionEpoch: '0123456789abcdef0123456789abcdef',
    revision: 18,
  };

  function receiptStorage(overrides: {
    state?: unknown;
    locale?: string | null;
    rawReceipt?: string | null;
  } = {}): Map<string, string> {
    const state = 'state' in overrides
      ? overrides.state
      : {
          ...buildSeed(NOW),
          profile: { displayName: 'Ada', telegramId: '42' },
        };
    const storage = new Map<string, string>();
    storage.set('cometa.bank', storedEnvelope(state));
    if (overrides.locale !== null) storage.set('cometa.bank.locale', overrides.locale ?? 'en');
    if (overrides.rawReceipt !== null) {
      storage.set(
        'cometa.bank.launch-preferences-receipt',
        overrides.rawReceipt ?? JSON.stringify(receipt),
      );
    }
    return storage;
  }

  it('loads only a receipt linked to the valid Telegram BankState and locale', () => {
    const storage = receiptStorage();
    vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => storage.get(key) ?? null) });

    expect(loadAppliedLaunchPreferencesReceipt()).toEqual(receipt);
  });

  it('rejects orphan receipts after BankState loss, corruption, or identity change', () => {
    for (const storage of [
      receiptStorage({ state: null }),
      receiptStorage({ locale: null }),
      receiptStorage({
        state: { ...buildSeed(NOW), profile: { displayName: 'Grace', telegramId: '43' } },
      }),
      receiptStorage({ rawReceipt: JSON.stringify({ ...receipt, revision: 1.5 }) }),
      receiptStorage({ rawReceipt: JSON.stringify({ ...receipt, revisionEpoch: 'not-an-epoch' }) }),
    ]) {
      vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => storage.get(key) ?? null) });
      expect(loadAppliedLaunchPreferencesReceipt()).toBeNull();
    }
  });

  it('rejects a receipt issued for bank schema v3', () => {
    const storage = receiptStorage({
      rawReceipt: JSON.stringify({ ...receipt, bankSchemaVersion: 3 }),
    });
    vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => storage.get(key) ?? null) });

    expect(loadAppliedLaunchPreferencesReceipt()).toBeNull();
  });

  it('persists only a canonical positive receipt', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    expect(saveAppliedLaunchPreferencesReceipt(receipt)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      'cometa.bank.launch-preferences-receipt',
      JSON.stringify(receipt),
    );
    expect(saveAppliedLaunchPreferencesReceipt({ ...receipt, revision: 0 })).toBe(false);
    expect(saveAppliedLaunchPreferencesReceipt({ ...receipt, telegramId: '01' })).toBe(false);
    expect(saveAppliedLaunchPreferencesReceipt({ ...receipt, revisionEpoch: 'A'.repeat(32) })).toBe(
      false,
    );
  });
});
