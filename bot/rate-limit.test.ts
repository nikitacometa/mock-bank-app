import { describe, expect, it } from 'vitest';
import { InMemoryBankRequestLimiter } from './rate-limit.js';

const FINGERPRINT_A = '1'.repeat(64);
const FINGERPRINT_B = '2'.repeat(64);

describe('InMemoryBankRequestLimiter', () => {
  it('charges import ingress independently before durable replay classification', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import_ingress: { maximum: 1, windowMs: 10_000 },
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const ingress = {
      telegramUserId: '42',
      kind: 'import_ingress' as const,
      sourceKind: 'tma' as const,
      operationId: 'import_ingress',
      durableReplay: false,
      nowMs: 1_000,
    };
    const mutation = {
      telegramUserId: '42',
      kind: 'import' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      durableReplay: false,
      nowMs: 1_000,
    };

    expect(limiter.consume(ingress)).toBeNull();
    expect(limiter.consume(ingress)).toBe(10);
    expect(() => limiter.consume({ ...ingress, durableReplay: true })).toThrow(TypeError);
    expect(() => limiter.consume({ ...mutation, durableReplay: true })).toThrow(TypeError);
    expect(limiter.consume(mutation)).toBeNull();
    expect(limiter.consume({
      ...mutation,
      replayFingerprint: FINGERPRINT_A,
      durableReplay: true,
    })).toBeNull();
    expect(limiter.consume({ ...mutation, operationId: 'b'.repeat(32) })).toBe(10);
  });

  it('bounds bootstrap attempts per user without replay exemptions', () => {
    const limiter = new InMemoryBankRequestLimiter({
      bootstrap: { maximum: 2, windowMs: 10_000 },
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const request = {
      telegramUserId: '42',
      kind: 'bootstrap' as const,
      sourceKind: 'tma' as const,
      operationId: 'bootstrap',
      durableReplay: false,
      nowMs: 1_000,
    };

    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume(request)).toBe(10);
    expect(limiter.consume({ ...request, telegramUserId: '43' })).toBeNull();
    expect(() => limiter.consume({ ...request, durableReplay: true })).toThrow(TypeError);
  });

  it('charges command ingress independently and never grants it a replay exemption', () => {
    const limiter = new InMemoryBankRequestLimiter({
      command_ingress: { maximum: 1, windowMs: 10_000 },
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const ingress = {
      telegramUserId: '42',
      kind: 'command_ingress' as const,
      sourceKind: 'tma' as const,
      operationId: 'command_ingress',
      durableReplay: false,
      nowMs: 1_000,
    };

    expect(limiter.consume(ingress)).toBeNull();
    expect(limiter.consume(ingress)).toBe(10);
    expect(() => limiter.consume({ ...ingress, durableReplay: true })).toThrow(TypeError);
  });

  it('bounds each user and route independently while admitting durable retries', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 2, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 1_000 },
      rates: { maximum: 1, windowMs: 1_000 },
    });
    const request = {
      telegramUserId: '42',
      kind: 'import' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replayFingerprint: FINGERPRINT_A,
      durableReplay: false,
      nowMs: 1_000,
    };
    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume({ ...request, durableReplay: true })).toBeNull();
    expect(limiter.consume({ ...request, operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
      .toBe(10);
    expect(limiter.consume({
      ...request,
      telegramUserId: '43',
      operationId: 'cccccccccccccccccccccccccccccccc',
    })).toBeNull();
    expect(limiter.consume({
      ...request,
      kind: 'command',
      operationId: 'cccccccccccccccccccccccccccccccc',
    })).toBeNull();
    const ratesRequest = {
      ...request,
      kind: 'rates' as const,
      operationId: 'dddddddddddddddddddddddddddddddd',
      replayFingerprint: undefined,
      durableReplay: false,
    };
    expect(limiter.consume(ratesRequest)).toBeNull();
    expect(limiter.consume(ratesRequest)).toBe(1);
  });

  it('charges repeated non-durable requests while exempting only persisted exact replays', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const request = {
      telegramUserId: '42',
      kind: 'command' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replayFingerprint: FINGERPRINT_A,
      durableReplay: false,
      nowMs: 1_000,
    };

    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume(request)).toBe(10);
    expect(limiter.consume({ ...request, durableReplay: true })).toBeNull();
    expect(limiter.consume({ ...request, replayFingerprint: FINGERPRINT_B })).toBe(10);
  });

  it('starts a fresh window at the boundary and recovers from clock rollback', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 1_000 },
      rates: { maximum: 1, windowMs: 1_000 },
    });
    const request = {
      telegramUserId: '42',
      kind: 'command' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replayFingerprint: FINGERPRINT_A,
      durableReplay: false,
      nowMs: 10_000,
    };
    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume({ ...request, operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
      .toBe(1);
    expect(limiter.consume({
      ...request,
      operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      nowMs: 11_000,
    })).toBeNull();
    expect(limiter.consume({
      ...request,
      operationId: 'cccccccccccccccccccccccccccccccc',
      nowMs: 9_000,
    })).toBeNull();
  });

  it('shares one command budget across TMA and Telegram while exempting exact replays', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const tma = {
      telegramUserId: '42',
      kind: 'command' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replayFingerprint: FINGERPRINT_A,
      durableReplay: false,
      nowMs: 1_000,
    };
    const telegram = {
      ...tma,
      sourceKind: 'telegram' as const,
      operationId: '1234',
    };

    expect(limiter.consume(tma)).toBeNull();
    expect(limiter.consume({ ...tma, durableReplay: true })).toBeNull();
    expect(limiter.consume(telegram)).toBe(10);
    expect(limiter.consume({ ...telegram, telegramUserId: '43' })).toBeNull();

    const telegramFirst = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    expect(telegramFirst.consume(telegram)).toBeNull();
    expect(telegramFirst.consume({ ...telegram, durableReplay: true })).toBeNull();
    expect(telegramFirst.consume(tma)).toBe(10);
  });

  it('charges every rate refresh even when the client mutation ID repeats', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    });
    const request = {
      telegramUserId: '42',
      kind: 'rates' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      durableReplay: false,
      nowMs: 1_000,
    };

    expect(limiter.consume(request)).toBeNull();
    expect(limiter.consume(request)).toBe(10);
  });

  it('counts users instead of route buckets and evicts the oldest whole user', () => {
    const limiter = new InMemoryBankRequestLimiter({
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    }, 2);
    const command = {
      telegramUserId: '42',
      kind: 'command' as const,
      sourceKind: 'tma' as const,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replayFingerprint: FINGERPRINT_A,
      durableReplay: false,
      nowMs: 1_000,
    };
    const rates = {
      telegramUserId: '42',
      kind: 'rates' as const,
      sourceKind: 'tma' as const,
      operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      durableReplay: false,
      nowMs: 1_001,
    };

    expect(limiter.consume(command)).toBeNull();
    expect(limiter.consume(rates)).toBeNull();
    expect(limiter.consume({
      ...command,
      telegramUserId: '43',
      operationId: 'cccccccccccccccccccccccccccccccc',
      nowMs: 1_002,
    })).toBeNull();

    // Touch every route for user 42 as one LRU identity, then add user 44.
    expect(limiter.consume({ ...command, durableReplay: true, nowMs: 1_003 })).toBeNull();
    expect(limiter.consume({
      ...command,
      telegramUserId: '44',
      operationId: 'dddddddddddddddddddddddddddddddd',
      nowMs: 1_004,
    })).toBeNull();

    // User 42 kept both charged route buckets; user 43 was evicted wholesale.
    expect(limiter.consume({ ...command, nowMs: 1_005 })).toBe(10);
    expect(limiter.consume({ ...rates, nowMs: 1_005 })).toBe(10);
    expect(limiter.consume({
      ...command,
      telegramUserId: '43',
      operationId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      nowMs: 1_006,
    })).toBeNull();
  });

  it('rejects invalid tracked-user capacities', () => {
    const policies = {
      import: { maximum: 1, windowMs: 10_000 },
      command: { maximum: 1, windowMs: 10_000 },
      rates: { maximum: 1, windowMs: 10_000 },
    };

    expect(() => new InMemoryBankRequestLimiter(policies, 0)).toThrow(TypeError);
    expect(() => new InMemoryBankRequestLimiter(policies, 2_049)).toThrow(TypeError);
  });
});
