import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalJsonDigest } from './canonical-json.js';
import {
  BankIdempotencyConflictError,
  BankOperationCapacityError,
  BankStateCapacityError,
  BankStateAlreadyExistsError,
  MAX_BANK_STATE_JSON_BYTES,
  PreferencesRepository,
  PROCESSED_UPDATE_RETENTION_LIMIT,
  UPDATE_SEQUENCE_RESET_AFTER_MS,
} from './repository.js';

function createUser(repository: PreferencesRepository, id = '42') {
  return repository.ensureUser({
    telegramUserId: id,
    locale: 'en',
    primaryCurrency: 'KZT',
    displayName: 'Ada',
  });
}

describe('PreferencesRepository', () => {
  it('creates canonical decimal-string users including one-digit IDs', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      const created = createUser(repository, '7');
      expect(created.created).toBe(true);
      expect(created.user).toMatchObject({
        telegramUserId: '7',
        locale: 'en',
        primaryCurrency: 'KZT',
        displayName: 'Ada',
        revision: 1,
        stage: 'language',
      });
      expect(createUser(repository, '7').created).toBe(false);
      expect(() => createUser(repository, '07')).toThrow('Invalid Telegram user ID');
    } finally {
      repository.close();
    }
  });

  it('bumps revision only for changed values outside an explicit preference intent', () => {
    let tick = 0;
    const repository = new PreferencesRepository(
      ':memory:',
      () => new Date(1_700_000_000_000 + tick++ * 1_000),
    );
    try {
      const initial = createUser(repository).user;
      const stageOnly = repository.updateUser('42', { stage: 'currency' });
      const unchanged = repository.updateUser('42', { locale: 'en', stage: 'currency' });
      const changed = repository.updateUser('42', {
        locale: 'ru',
        primaryCurrency: 'GEL',
        displayName: 'Ада',
        stage: 'complete',
      });
      const repeated = repository.updateUser('42', {
        locale: 'ru',
        primaryCurrency: 'GEL',
        displayName: 'Ада',
        stage: 'complete',
      });

      expect(stageOnly.revision).toBe(1);
      expect(stageOnly.updatedAt).not.toBe(initial.updatedAt);
      expect(unchanged).toEqual(stageOnly);
      expect(changed.revision).toBe(2);
      expect(repeated).toEqual(changed);
    } finally {
      repository.close();
    }
  });

  it('bumps every explicit equal-value preference intent while stage-only updates stay idempotent', () => {
    let tick = 0;
    const repository = new PreferencesRepository(
      ':memory:',
      () => new Date(1_700_000_000_000 + tick++ * 1_000),
    );
    try {
      const initial = createUser(repository).user;
      const stageOnly = repository.updateUser('42', { stage: 'currency' });
      const applied = repository.applyPreferenceIntent('42', {
        locale: 'en',
        stage: 'currency',
      });
      const nextIntent = repository.applyPreferenceIntent('42', {
        primaryCurrency: 'KZT',
        stage: 'complete',
      });

      expect(stageOnly).toMatchObject({ stage: 'currency', revision: 1 });
      expect(applied).toMatchObject({
        locale: 'en',
        primaryCurrency: 'KZT',
        stage: 'currency',
        revision: 2,
      });
      expect(applied.updatedAt).not.toBe(initial.updatedAt);
      expect(nextIntent).toMatchObject({
        locale: 'en',
        primaryCurrency: 'KZT',
        stage: 'complete',
        revision: 3,
      });
    } finally {
      repository.close();
    }
  });

  it('rejects an intent when the preference revision cannot advance without changing state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-revision-overflow-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const setup = new PreferencesRepository(path);
      createUser(setup);
      setup.close();

      const database = new DatabaseSync(path);
      database.prepare('UPDATE users SET revision = ? WHERE telegram_user_id = ?')
        .run(Number.MAX_SAFE_INTEGER, '42');
      database.close();

      const repository = new PreferencesRepository(path);
      try {
        expect(() => repository.applyPreferenceIntent('42', {
          locale: 'ru',
          stage: 'complete',
        })).toThrow('Preference revision overflow');
        expect(repository.getUser('42')).toMatchObject({
          locale: 'en',
          stage: 'language',
          revision: Number.MAX_SAFE_INTEGER,
        });
      } finally {
        repository.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores SQL-shaped display names as data', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository);
      const payload = "x'); DROP TABLE users;--";
      expect(repository.updateUser('42', { displayName: payload }).displayName).toBe(payload);
      expect(repository.getUser('42')?.displayName).toBe(payload);
    } finally {
      repository.close();
    }
  });

  it('deduplicates only exact update IDs while preserving the provider offset', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      expect(repository.markProcessed(41)).toBe(true);
      expect(repository.markProcessed(41)).toBe(false);
      expect(repository.markProcessed(43)).toBe(true);
      expect(repository.hasProcessedUpdate(42)).toBe(false);
      expect(repository.nextUpdateOffset()).toBe(44);
    } finally {
      repository.close();
    }
  });

  it('preserves preferences and processed updates across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-repository-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const first = new PreferencesRepository(path);
      const revisionEpoch = first.revisionEpoch();
      createUser(first);
      first.updateUser('42', { primaryCurrency: 'EUR', stage: 'complete' });
      first.markProcessed(991);
      first.close();

      const second = new PreferencesRepository(path);
      try {
        expect(second.getUser('42')).toMatchObject({
          primaryCurrency: 'EUR',
          stage: 'complete',
          revision: 2,
        });
        expect(second.hasProcessedUpdate(991)).toBe(true);
        expect(second.nextUpdateOffset()).toBe(992);
        expect(second.revisionEpoch()).toBe(revisionEpoch);
      } finally {
        second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds exact processed update history without treating pruned IDs as duplicates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-retention-'));
    const path = join(directory, 'bot.sqlite');
    const firstUpdateId = 10_000;
    const lastUpdateId = firstUpdateId + PROCESSED_UPDATE_RETENTION_LIMIT + 1;
    try {
      const repository = new PreferencesRepository(path);
      for (let updateId = firstUpdateId; updateId <= lastUpdateId; updateId += 1) {
        expect(repository.markProcessed(updateId)).toBe(true);
      }
      expect(repository.hasProcessedUpdate(firstUpdateId)).toBe(false);
      expect(repository.nextUpdateOffset()).toBe(lastUpdateId + 1);
      repository.close();

      const database = new DatabaseSync(path, { readOnly: true });
      const summary = database.prepare(`
        SELECT COUNT(*) AS count, MIN(update_id) AS minimum, MAX(update_id) AS maximum
        FROM processed_updates
      `).get() as Record<string, number>;
      database.close();
      expect(summary).toEqual({
        count: PROCESSED_UPDATE_RETENTION_LIMIT,
        minimum: lastUpdateId - PROCESSED_UPDATE_RETENTION_LIMIT + 1,
        maximum: lastUpdateId,
      });

      const restarted = new PreferencesRepository(path);
      try {
        expect(restarted.hasProcessedUpdate(firstUpdateId)).toBe(false);
        expect(restarted.nextUpdateOffset()).toBe(lastUpdateId + 1);
      } finally {
        restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('migrates a version-one update log into a durable watermark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-v1-migration-'));
    const path = join(directory, 'bot.sqlite');
    const firstUpdateId = 100;
    const lastUpdateId = firstUpdateId + PROCESSED_UPDATE_RETENTION_LIMIT + 1;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE processed_updates (
          update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
          processed_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
        BEGIN IMMEDIATE;
      `);
      const insert = legacy.prepare(`
        INSERT INTO processed_updates (update_id, processed_at)
        VALUES (?, '2023-01-01T00:00:00.000Z')
      `);
      for (let updateId = firstUpdateId; updateId <= lastUpdateId; updateId += 1) {
        insert.run(updateId);
      }
      legacy.exec('COMMIT');
      legacy.close();

      const migrated = new PreferencesRepository(path);
      try {
        expect(migrated.nextUpdateOffset()).toBe(lastUpdateId + 1);
        expect(migrated.hasProcessedUpdate(firstUpdateId)).toBe(false);
        expect(migrated.revisionEpoch()).toMatch(/^[0-9a-f]{32}$/);
      } finally {
        migrated.close();
      }

      const inspected = new DatabaseSync(path, { readOnly: true });
      const version = inspected.prepare('PRAGMA user_version').get();
      const retained = inspected.prepare('SELECT COUNT(*) AS count FROM processed_updates').get();
      inspected.close();
      expect(version).toEqual({ user_version: 2 });
      expect(retained).toEqual({ count: PROCESSED_UPDATE_RETENTION_LIMIT });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('durably expires a high update sequence before Telegram can randomize its next ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-update-epoch-'));
    const path = join(directory, 'bot.sqlite');
    let nowMs = 1_700_000_000_000;
    const clock = () => new Date(nowMs);
    try {
      const first = new PreferencesRepository(path, clock);
      first.markProcessed(900_000);
      expect(first.preparePolling()).toBe(900_001);
      first.close();

      nowMs += UPDATE_SEQUENCE_RESET_AFTER_MS - 1;
      const beforeBoundary = new PreferencesRepository(path, clock);
      expect(beforeBoundary.preparePolling()).toBe(900_001);
      beforeBoundary.close();

      nowMs += 1;
      const expired = new PreferencesRepository(path, clock);
      try {
        expect(expired.preparePolling()).toBeUndefined();
        expect(expired.nextUpdateOffset()).toBeUndefined();
        expect(expired.hasProcessedUpdate(900_000)).toBe(false);
        expect(expired.markProcessed(17)).toBe(true);
        expect(expired.nextUpdateOffset()).toBe(18);
      } finally {
        expired.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists a custom-name reply atomically and never applies its revision twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-pending-reply-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const first = new PreferencesRepository(path);
      createUser(first);
      first.updateUser('42', { stage: 'custom_name' });
      const applied = first.applyCustomNameIntent('42', '42', 700, 'Grace');
      expect(applied).toMatchObject({
        displayName: 'Grace',
        stage: 'complete',
        revision: 2,
      });
      expect(first.getPendingReply(700)).toEqual({
        sourceUpdateId: 700,
        telegramUserId: '42',
        chatId: '42',
        kind: 'custom_name_summary',
      });
      first.close();

      const restarted = new PreferencesRepository(path);
      try {
        const replayed = restarted.applyCustomNameIntent('42', '42', 700, 'Ignored');
        expect(replayed).toMatchObject({ displayName: 'Grace', revision: 2 });
        expect(restarted.completePendingReply(700)).toBe(true);
        expect(restarted.completePendingReply(700)).toBe(false);
      } finally {
        restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('extends schema two idempotently while legacy repository operations keep working', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-v2-extension-'));
    const path = join(directory, 'bot.sqlite');
    const initialMs = 1_700_000_000_000;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE users (
          telegram_user_id TEXT PRIMARY KEY,
          locale TEXT NOT NULL,
          primary_currency TEXT NOT NULL,
          display_name TEXT NOT NULL,
          revision INTEGER NOT NULL,
          stage TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE processed_updates (
          update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
          processed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE service_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_update_offset INTEGER
        ) STRICT;
        INSERT INTO users (
          telegram_user_id, locale, primary_currency, display_name,
          revision, stage, updated_at
        ) VALUES ('42', 'en', 'KZT', 'Ada', 1, 'complete', '2023-11-14T22:13:20.000Z');
        INSERT INTO processed_updates (update_id, processed_at)
        VALUES (41, '2023-11-14T22:13:20.000Z');
        INSERT INTO service_state (singleton, next_update_offset) VALUES (1, 42);
        PRAGMA user_version = 2;
      `);
      legacy.close();

      const extended = new PreferencesRepository(path, () => new Date(initialMs));
      const revisionEpoch = extended.revisionEpoch();
      expect(extended.nextUpdateOffset()).toBe(42);
      extended.close();

      const rollbackImage = new DatabaseSync(path);
      expect(rollbackImage.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(rollbackImage.prepare(`
        SELECT telegram_user_id, locale, primary_currency, display_name,
               revision, stage, updated_at
        FROM users
        WHERE telegram_user_id = '42'
      `).get()).toMatchObject({ telegram_user_id: '42', revision: 1 });
      rollbackImage.exec(`
        UPDATE users
        SET locale = 'ru', revision = 2, updated_at = '2023-11-19T22:13:20.000Z'
        WHERE telegram_user_id = '42';
        INSERT INTO processed_updates (update_id, processed_at)
        VALUES (43, '2023-11-19T22:13:20.000Z');
        UPDATE service_state SET next_update_offset = 44 WHERE singleton = 1;
      `);
      rollbackImage.close();

      const reopened = new PreferencesRepository(
        path,
        () => new Date(initialMs + UPDATE_SEQUENCE_RESET_AFTER_MS + 1),
      );
      try {
        expect(reopened.revisionEpoch()).toBe(revisionEpoch);
        expect(reopened.getUser('42')).toMatchObject({ locale: 'ru', revision: 2 });
        expect(reopened.preparePolling()).toBe(44);
        expect(reopened.listPendingReplies()).toEqual([]);
      } finally {
        reopened.close();
      }

      const idempotentReopen = new PreferencesRepository(path);
      try {
        expect(idempotentReopen.revisionEpoch()).toBe(revisionEpoch);
      } finally {
        idempotentReopen.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an update whose next offset is unsafe without moving the watermark', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      repository.markProcessed(41);
      expect(() => repository.markProcessed(Number.MAX_SAFE_INTEGER)).toThrow(
        'Update offset overflow',
      );
      expect(repository.nextUpdateOffset()).toBe(42);
      expect(repository.hasProcessedUpdate(Number.MAX_SAFE_INTEGER)).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('fails closed when the database schema is newer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-schema-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const database = new DatabaseSync(path);
      database.exec('PRAGMA user_version = 3');
      database.close();
      expect(() => new PreferencesRepository(path)).toThrow(
        'SQLite schema is newer than this service',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps SQLite at bridge-compatible version two while adding bank tables in local mode', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      expect(repository.ledgerMode()).toBe('local');
      repository.setLedgerMode('server');
      expect(repository.ledgerMode()).toBe('server');
      expect(repository.ping()).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('imports once per user and binds idempotency to the exact canonical payload hash', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository, '42');
      createUser(repository, '43');
      const state = { owner: '42', balanceMinor: 100_00 };
      const stateJson = canonicalJson(state);
      const commandHash = canonicalJsonDigest({ stateVersion: 5, state });
      expect(repository.isExactBankOperation(
        '42',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash,
      )).toBe(false);
      expect(repository.hasBankOperation(
        '42',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )).toBe(false);
      const imported = repository.importBankState({
        telegramUserId: '42',
        operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash,
        stateJson,
        outcome: { imported: true },
      });
      const replay = repository.importBankState({
        telegramUserId: '42',
        operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash,
        stateJson,
        outcome: { imported: true },
      });

      expect(imported).toMatchObject({ replayed: false, operationRevision: 1 });
      expect(replay).toMatchObject({ replayed: true, operationRevision: 1 });
      expect(replay.operationId).toBe(imported.operationId);
      expect(replay.state).toMatchObject({ revision: 1, digest: canonicalJsonDigest(state) });
      expect(repository.hasBankOperation(
        '42',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )).toBe(true);
      expect(repository.hasBankOperation(
        '43',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )).toBe(false);
      expect(repository.isExactBankOperation(
        '42',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash,
      )).toBe(true);
      expect(repository.isExactBankOperation(
        '42',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        canonicalJsonDigest({ stateVersion: 5, state: { ...state, balanceMinor: 1 } }),
      )).toBe(false);
      expect(repository.isExactBankOperation(
        '43',
        'import',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash,
      )).toBe(false);
      expect(repository.getBankState('43')).toBeNull();
      expect(() => repository.importBankState({
        telegramUserId: '42',
        operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commandHash: canonicalJsonDigest({ stateVersion: 5, state: { ...state, balanceMinor: 1 } }),
        stateJson,
        outcome: { imported: true },
      })).toThrow(BankIdempotencyConflictError);
      expect(() => repository.importBankState({
        telegramUserId: '42',
        operationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        commandHash,
        stateJson,
        outcome: { imported: true },
      })).toThrow(BankStateAlreadyExistsError);
      expect(repository.getBankState('42')?.state).toEqual(state);
    } finally {
      repository.close();
    }
  });

  it('rejects an oversized imported state with a typed error before writing anything', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository);
      expect(() => repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ payload: 'x'.repeat(MAX_BANK_STATE_JSON_BYTES) }),
        outcome: { imported: true },
      })).toThrow(BankStateCapacityError);
      expect(repository.getBankState('42')).toBeNull();
      expect(repository.hasBankOperation('42', 'import', 'import_1')).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('rolls back replay pruning when a replacement state exceeds the storage limit', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 1,
    });
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      const retained = {
        telegramUserId: '42',
        sourceKind: 'tma' as const,
        operationId: 'a'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'set_primary_currency',
      };
      repository.executeBankOperation(retained, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
      }));

      expect(() => repository.executeBankOperation({
        ...retained,
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
      }, () => ({
        stateJson: canonicalJson({ payload: 'x'.repeat(MAX_BANK_STATE_JSON_BYTES) }),
        outcome: { applied: true },
      }))).toThrow(BankStateCapacityError);
      expect(repository.hasBankOperation('42', 'tma', retained.operationId)).toBe(true);
      expect(repository.hasBankOperation('42', 'tma', 'b'.repeat(32))).toBe(false);
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 100 },
      });
    } finally {
      repository.close();
    }
  });

  it('commits state, operation outcome, and chat outbox atomically and replays without mutation', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100_00 }),
        outcome: { imported: true },
      });
      const input = {
        telegramUserId: '42',
        sourceKind: 'telegram' as const,
        operationId: '700',
        commandHash: canonicalJsonDigest({ amountMinor: 30_00 }),
        operationKind: 'record_transaction',
        chatId: '42',
      };
      let transitions = 0;
      const first = repository.executeBankOperation(input, (raw) => {
        transitions += 1;
        const current = raw as { balanceMinor: number };
        const next = { balanceMinor: current.balanceMinor - 30_00 };
        return {
          stateJson: canonicalJson(next),
          outcome: { applied: true, amountMinor: 30_00 },
          outbox: {
            messageKind: 'bank_operation_result',
            payload: { kind: 'record_transaction', amountMinor: 30_00 },
          },
        };
      });
      const replay = repository.executeBankOperation(input, () => {
        transitions += 1;
        throw new Error('replay must not invoke transition');
      });

      expect(transitions).toBe(1);
      expect(first).toMatchObject({ replayed: false, operationRevision: 2 });
      expect(replay).toMatchObject({
        replayed: true,
        operationId: first.operationId,
        operationRevision: 2,
        outcome: { applied: true, amountMinor: 30_00 },
      });
      expect(replay.state.state).toEqual({ balanceMinor: 70_00 });
      expect(repository.listBankOutbox()).toEqual([expect.objectContaining({
        bankOperationId: first.operationId,
        telegramUserId: '42',
        chatId: '42',
        messageKind: 'bank_operation_result',
        payload: { amountMinor: 30_00, kind: 'record_transaction' },
      })]);
      expect(repository.hasBankOutboxForOperation('42', 'telegram', '700')).toBe(true);
      expect(repository.hasBankOutboxForOperation('42', 'telegram', '701')).toBe(false);
      expect(repository.completeBankOutbox(repository.listBankOutbox()[0]!.id)).toBe(true);
      expect(repository.hasBankOutboxForOperation('42', 'telegram', '700')).toBe(false);
      expect(repository.completeBankOutbox(1)).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('slides the bounded operation window by pruning the oldest completed replay', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 2,
    });
    try {
      createUser(repository, '42');
      createUser(repository, '43');
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      const firstInput = {
        telegramUserId: '42',
        sourceKind: 'tma' as const,
        operationId: 'a'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'set_primary_currency',
      };
      const first = repository.executeBankOperation(firstInput, () => ({
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { applied: false },
      }));
      repository.executeBankOperation({
        ...firstInput,
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
      }, () => ({
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { applied: false },
      }));

      const third = repository.executeBankOperation({
        ...firstInput,
        operationId: 'c'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 3 }),
      }, () => {
        return {
          stateJson: canonicalJson({ balanceMinor: 99 }),
          outcome: { applied: true },
        };
      });
      expect(third).toMatchObject({ replayed: false, operationRevision: 2 });
      expect(repository.getBankState('42')).toMatchObject({
        revision: 2,
        state: { balanceMinor: 99 },
      });
      expect(repository.listBankOutbox()).toEqual([]);
      expect(repository.hasBankOperation('42', 'tma', firstInput.operationId)).toBe(false);
      expect(repository.executeBankOperation({
        ...firstInput,
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
      }, () => {
        throw new Error('replay must not execute');
      })).toMatchObject({ replayed: true });
      expect(repository.hasBankOperation('42', 'tma', 'c'.repeat(32))).toBe(true);
      expect(first.operationId).toBeGreaterThan(0);

      repository.importBankState({
        telegramUserId: '43',
        operationId: 'import_2',
        commandHash: canonicalJsonDigest({ import: 2 }),
        stateJson: canonicalJson({ balanceMinor: 200 }),
        outcome: { imported: true },
      });
      expect(repository.getBankState('43')).toMatchObject({ state: { balanceMinor: 200 } });
    } finally {
      repository.close();
    }
  });

  it('protects pending outbox operations when every retained replay is undelivered', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 1,
    });
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      const retained = {
        telegramUserId: '42',
        sourceKind: 'telegram' as const,
        operationId: '700',
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'record_transaction',
        chatId: '42',
      };
      repository.executeBankOperation(retained, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
        outbox: { messageKind: 'bank_operation_result', payload: { applied: false } },
      }));

      let transitionCalls = 0;
      expect(() => repository.executeBankOperation({
        ...retained,
        sourceKind: 'tma',
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
        chatId: undefined,
      }, (state) => {
        transitionCalls += 1;
        return {
          stateJson: canonicalJson({ ...(state as object), balanceMinor: 99 }),
          outcome: { applied: true },
        };
      })).toThrow(BankOperationCapacityError);
      expect(transitionCalls).toBe(0);
      expect(repository.hasBankOperation('42', 'telegram', '700')).toBe(true);
      expect(repository.hasBankOperation('42', 'tma', 'b'.repeat(32))).toBe(false);
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 100 },
      });
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('prunes the oldest completed replay while keeping an older pending outbox replay', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 2,
    });
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      repository.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '700',
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'record_transaction',
        chatId: '42',
      }, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
        outbox: { messageKind: 'bank_operation_result', payload: { applied: false } },
      }));
      const completed = {
        telegramUserId: '42',
        sourceKind: 'tma' as const,
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
        operationKind: 'set_primary_currency',
      };
      repository.executeBankOperation(completed, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
      }));

      repository.executeBankOperation({
        ...completed,
        operationId: 'c'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 3 }),
      }, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
      }));

      expect(repository.hasBankOperation('42', 'telegram', '700')).toBe(true);
      expect(repository.hasBankOperation('42', 'tma', completed.operationId)).toBe(false);
      expect(repository.hasBankOperation('42', 'tma', 'c'.repeat(32))).toBe(true);
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('restores a pruned replay when the replacement transition rolls back', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 1,
    });
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      const retained = {
        telegramUserId: '42',
        sourceKind: 'tma' as const,
        operationId: 'a'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'set_primary_currency',
      };
      repository.executeBankOperation(retained, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
      }));

      expect(() => repository.executeBankOperation({
        ...retained,
        operationId: 'b'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 2 }),
      }, () => {
        throw new Error('replacement failed');
      })).toThrow('replacement failed');
      expect(repository.hasBankOperation('42', 'tma', retained.operationId)).toBe(true);
      expect(repository.hasBankOperation('42', 'tma', 'b'.repeat(32))).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('still commits a bounded system materialization after the user-operation cap is full', () => {
    const repository = new PreferencesRepository(':memory:', () => new Date(), {
      maxBankOperationsPerUser: 1,
    });
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ due: true }),
        outcome: { imported: true },
      });
      repository.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'tma',
        operationId: 'a'.repeat(32),
        commandHash: canonicalJsonDigest({ command: 1 }),
        operationKind: 'set_primary_currency',
      }, () => ({
        stateJson: canonicalJson({ due: true }),
        outcome: { applied: false },
      }));

      const materialized = repository.mutateBankState('42', () => ({
        stateJson: canonicalJson({ due: false, paused: true }),
        outcome: { warnings: [{ ruleId: 'rr_due', reason: 'insufficient_funds' }] },
        outbox: {
          messageKind: 'bank_materialization_warning',
          payload: { warnings: [{ ruleId: 'rr_due', reason: 'insufficient_funds' }] },
        },
      }));

      expect(materialized).toMatchObject({
        changed: true,
        state: { revision: 2, state: { due: false, paused: true } },
      });
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('keeps the sliding replay window after a repository restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-operation-cap-'));
    const path = join(directory, 'bot.sqlite');
    const command = {
      telegramUserId: '42',
      sourceKind: 'tma' as const,
      operationId: 'a'.repeat(32),
      commandHash: canonicalJsonDigest({ command: 1 }),
      operationKind: 'set_primary_currency',
    };
    try {
      const first = new PreferencesRepository(path, () => new Date(), {
        maxBankOperationsPerUser: 1,
      });
      createUser(first);
      first.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { imported: true },
      });
      first.executeBankOperation(command, () => ({
        stateJson: canonicalJson({ balanceMinor: 100 }),
        outcome: { applied: false },
      }));
      first.close();

      const reopened = new PreferencesRepository(path, () => new Date(), {
        maxBankOperationsPerUser: 1,
      });
      try {
        expect(reopened.executeBankOperation(command, () => {
          throw new Error('replay must not execute');
        })).toMatchObject({ replayed: true });
        const replacement = reopened.executeBankOperation({
          ...command,
          operationId: 'b'.repeat(32),
          commandHash: canonicalJsonDigest({ command: 2 }),
        }, () => ({
          stateJson: canonicalJson({ balanceMinor: 99 }),
          outcome: { applied: true },
        }));
        expect(replacement).toMatchObject({ replayed: false, operationRevision: 2 });
        expect(reopened.hasBankOperation('42', 'tma', command.operationId)).toBe(false);
        expect(reopened.hasBankOperation('42', 'tma', 'b'.repeat(32))).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


  it('rolls back a rejected overdraft transition without recording an operation or outbox', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 5_00 }),
        outcome: { imported: true },
      });
      const input = {
        telegramUserId: '42',
        sourceKind: 'telegram' as const,
        operationId: '701',
        commandHash: canonicalJsonDigest({ amountMinor: 6_00 }),
        operationKind: 'record_transaction',
        chatId: '42',
      };
      expect(() => repository.executeBankOperation(input, () => {
        throw new RangeError('insufficient_funds');
      })).toThrow('insufficient_funds');
      expect(repository.getBankState('42')).toMatchObject({
        revision: 1,
        state: { balanceMinor: 5_00 },
      });
      expect(repository.listBankOutbox()).toEqual([]);

      const applied = repository.executeBankOperation(input, () => ({
        stateJson: canonicalJson({ balanceMinor: 4_00 }),
        outcome: { applied: true },
      }));
      expect(applied).toMatchObject({ replayed: false, operationRevision: 2 });
    } finally {
      repository.close();
    }
  });

  it('materializes under the write transaction and bumps revision only when state changes', () => {
    const repository = new PreferencesRepository(':memory:');
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ due: true, balanceMinor: 100 }),
        outcome: { imported: true },
      });
      const changed = repository.mutateBankState('42', () => ({
        stateJson: canonicalJson({ due: false, balanceMinor: 90 }),
        outcome: { warnings: [{ ruleId: 'rr_due', reason: 'insufficient_funds' }] },
        outbox: {
          messageKind: 'bank_materialization_warning',
          payload: { warnings: [{ ruleId: 'rr_due', reason: 'insufficient_funds' }] },
        },
      }));
      const unchanged = repository.mutateBankState('42', (state) => ({
        stateJson: canonicalJson(state),
        outcome: { warnings: [] },
      }));
      expect(changed).toMatchObject({ changed: true, state: { revision: 2 } });
      expect(unchanged).toMatchObject({ changed: false, state: { revision: 2 } });
      expect(repository.listBankOutbox()).toEqual([expect.objectContaining({
        telegramUserId: '42',
        chatId: '42',
        messageKind: 'bank_materialization_warning',
        attempts: 0,
        nextAttemptAt: 0,
        payload: { warnings: [{ reason: 'insufficient_funds', ruleId: 'rr_due' }] },
      })]);
      expect(() => repository.mutateBankState('42', (state) => ({
        stateJson: canonicalJson(state),
        outcome: { warnings: [{ ruleId: 'rr_duplicate', reason: 'capacity' }] },
        outbox: {
          messageKind: 'bank_materialization_warning',
          payload: { warnings: [{ ruleId: 'rr_duplicate', reason: 'capacity' }] },
        },
      }))).toThrow('Materialization outbox requires a state change');
      expect(repository.listBankOutbox()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('persists per-row bank outbox backoff across restart and exposes it only when due', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-outbox-retry-'));
    const path = join(directory, 'bot.sqlite');
    let nowMs = 1_700_000_000_000;
    const clock = () => new Date(nowMs);
    try {
      const first = new PreferencesRepository(path, clock);
      createUser(first);
      first.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100_00 }),
        outcome: { imported: true },
      });
      first.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '702',
        commandHash: canonicalJsonDigest({ currency: 'USD' }),
        operationKind: 'set_primary_currency',
        chatId: '42',
      }, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
        outbox: { messageKind: 'bank_operation_result', payload: { applied: false } },
      }));
      const pending = first.listDueBankOutbox()[0];
      if (pending === undefined) throw new Error('Missing due bank outbox row');
      expect(pending).toMatchObject({ attempts: 0, nextAttemptAt: 0 });
      expect(first.deferBankOutbox(pending.id, 1, nowMs + 37_000)).toBe(true);
      expect(first.deferBankOutbox(pending.id, 1, nowMs + 38_000)).toBe(false);
      expect(first.listDueBankOutbox()).toEqual([]);
      expect(first.listBankOutbox()[0]).toMatchObject({
        attempts: 1,
        nextAttemptAt: nowMs + 37_000,
      });
      first.close();

      const restarted = new PreferencesRepository(path, clock);
      expect(restarted.listDueBankOutbox()).toEqual([]);
      nowMs += 37_000;
      expect(restarted.listDueBankOutbox()).toEqual([
        expect.objectContaining({ attempts: 1, nextAttemptAt: nowMs }),
      ]);
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a saturated bank outbox retry row sleeping instead of leaving it permanently due', () => {
    const nowMs = 1_700_000_000_000;
    const repository = new PreferencesRepository(':memory:', () => new Date(nowMs));
    try {
      createUser(repository);
      repository.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100_00 }),
        outcome: { imported: true },
      });
      repository.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '704',
        commandHash: canonicalJsonDigest({ currency: 'USD' }),
        operationKind: 'set_primary_currency',
        chatId: '42',
      }, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
        outbox: { messageKind: 'bank_operation_result', payload: { applied: false } },
      }));
      const pending = repository.listDueBankOutbox()[0];
      if (pending === undefined) throw new Error('Missing due bank outbox row');

      expect(repository.deferBankOutbox(pending.id, 31, nowMs + 60_000)).toBe(true);
      expect(repository.deferBankOutbox(pending.id, 31, nowMs + 120_000)).toBe(true);
      expect(repository.deferBankOutbox(pending.id, 31, nowMs + 90_000)).toBe(false);
      expect(repository.listDueBankOutbox()).toEqual([]);
      expect(repository.listBankOutbox()[0]).toMatchObject({
        attempts: 31,
        nextAttemptAt: nowMs + 120_000,
      });
    } finally {
      repository.close();
    }
  });

  it('adds retry columns to a pre-retry bank outbox without losing queued messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bank-outbox-migration-'));
    const path = join(directory, 'bot.sqlite');
    try {
      const setup = new PreferencesRepository(path);
      createUser(setup);
      setup.importBankState({
        telegramUserId: '42',
        operationId: 'import_1',
        commandHash: canonicalJsonDigest({ import: 1 }),
        stateJson: canonicalJson({ balanceMinor: 100_00 }),
        outcome: { imported: true },
      });
      setup.executeBankOperation({
        telegramUserId: '42',
        sourceKind: 'telegram',
        operationId: '703',
        commandHash: canonicalJsonDigest({ name: 'Ada' }),
        operationKind: 'set_display_name',
        chatId: '42',
      }, (state) => ({
        stateJson: canonicalJson(state),
        outcome: { applied: false },
        outbox: { messageKind: 'bank_operation_result', payload: { applied: false } },
      }));
      setup.close();

      const legacy = new DatabaseSync(path);
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE bank_outbox RENAME TO bank_outbox_with_retry;
        CREATE TABLE bank_outbox (
          id INTEGER PRIMARY KEY,
          bank_operation_id INTEGER NOT NULL UNIQUE
            REFERENCES bank_operations (id) ON DELETE CASCADE,
          telegram_user_id TEXT NOT NULL
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL,
          message_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO bank_outbox (
          id, bank_operation_id, telegram_user_id, chat_id,
          message_kind, payload_json, created_at
        )
        SELECT id, bank_operation_id, telegram_user_id, chat_id,
               message_kind, payload_json, created_at
        FROM bank_outbox_with_retry;
        DROP TABLE bank_outbox_with_retry;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      legacy.close();

      const migrated = new PreferencesRepository(path);
      try {
        expect(migrated.listDueBankOutbox()).toEqual([
          expect.objectContaining({
            telegramUserId: '42',
            attempts: 0,
            nextAttemptAt: 0,
          }),
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores isolated durable wizard sessions and expires them after 24 hours', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-session-'));
    const path = join(directory, 'bot.sqlite');
    let nowMs = 1_700_000_000_000;
    const clock = () => new Date(nowMs);
    try {
      const first = new PreferencesRepository(path, clock);
      createUser(first, '42');
      createUser(first, '43');
      const expiresAt = new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString();
      first.upsertConversationSession({
        telegramUserId: '42',
        flowId: 'flow_abc',
        flowKind: 'transaction',
        step: 'amount',
        draft: { direction: 'expense' },
        expiresAt,
      });
      first.upsertConversationSession({
        telegramUserId: '43',
        flowId: 'flow_def',
        flowKind: 'accounts',
        step: 'currency',
        draft: {},
        expiresAt,
      });
      first.close();

      const restarted = new PreferencesRepository(path, clock);
      expect(restarted.getConversationSession('42')).toMatchObject({
        flowId: 'flow_abc',
        draft: { direction: 'expense' },
      });
      expect(restarted.getConversationSession('43')).toMatchObject({ flowId: 'flow_def' });
      nowMs += 24 * 60 * 60 * 1_000;
      expect(restarted.hasConversationSessionRecord('42')).toBe(true);
      expect(restarted.getConversationSession('42')).toBeNull();
      expect(restarted.hasConversationSessionRecord('42')).toBe(false);
      expect(restarted.hasConversationSessionRecord('43')).toBe(true);
      expect(restarted.getConversationSession('43')).toBeNull();
      expect(restarted.hasConversationSessionRecord('43')).toBe(false);
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically binds each wizard transition to one durable Telegram reply', () => {
    let nowMs = 1_700_000_000_000;
    const repository = new PreferencesRepository(':memory:', () => new Date(nowMs));
    try {
      createUser(repository, '42');
      const expiresAt = new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString();
      repository.upsertConversationSession({
        telegramUserId: '42',
        flowId: 'flow_abc',
        flowKind: 'transaction',
        step: 'amount',
        draft: { amount: null },
        expiresAt,
      });

      const queued = repository.upsertConversationSessionWithReply({
        sourceUpdateId: 10,
        chatId: '42',
        text: 'Who sent or received it?',
        replyMarkup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'b:flow_abc:bk' }]] },
        session: {
          telegramUserId: '42',
          flowId: 'flow_abc',
          flowKind: 'transaction',
          step: 'counterparty',
          draft: { amount: '25.00' },
          expiresAt,
        },
      });

      expect(queued).toMatchObject({
        sourceUpdateId: 10,
        status: 'pending',
        updateProcessed: false,
      });
      expect(repository.getConversationSession('42')).toMatchObject({
        step: 'counterparty',
        draft: { amount: '25.00' },
      });

      const replay = repository.upsertConversationSessionWithReply({
        sourceUpdateId: 10,
        chatId: '42',
        text: 'This must not replace the original reply',
        session: {
          telegramUserId: '42',
          flowId: 'flow_abc',
          flowKind: 'transaction',
          step: 'note',
          draft: { amount: '25.00', counterparty: '25.00' },
          expiresAt,
        },
      });

      expect(replay.text).toBe('Who sent or received it?');
      expect(repository.getConversationSession('42')).toMatchObject({ step: 'counterparty' });

      expect(() => repository.upsertConversationSessionWithReply({
        sourceUpdateId: 12,
        chatId: '42',
        text: 'A second pending reply must not accumulate',
        session: {
          telegramUserId: '42',
          flowId: 'flow_abc',
          flowKind: 'transaction',
          step: 'note',
          draft: { amount: '25.00', counterparty: 'Spotify' },
          expiresAt,
        },
      })).toThrow(/UNIQUE constraint failed: conversation_replies\.telegram_user_id/);
      expect(repository.getConversationSession('42')).toMatchObject({ step: 'counterparty' });

      repository.markProcessed(10);
      expect(repository.getConversationReply(10)).toMatchObject({
        status: 'pending',
        updateProcessed: true,
      });
      expect(repository.getPendingConversationReplyForUser('42')).toMatchObject({
        sourceUpdateId: 10,
      });
      for (
        let updateId = 11;
        updateId <= 10 + PROCESSED_UPDATE_RETENTION_LIMIT;
        updateId += 1
      ) {
        repository.markProcessed(updateId);
      }
      expect(repository.hasProcessedUpdate(10)).toBe(false);
      expect(repository.markConversationReplyDelivered(10)).toBe(true);
      expect(repository.getConversationReply(10)).toBeNull();

      const nextSourceUpdateId = 11 + PROCESSED_UPDATE_RETENTION_LIMIT;
      repository.upsertConversationSessionWithReply({
        sourceUpdateId: nextSourceUpdateId,
        chatId: '42',
        text: 'Add a note',
        session: {
          telegramUserId: '42',
          flowId: 'flow_abc',
          flowKind: 'transaction',
          step: 'note',
          draft: { amount: '25.00', counterparty: 'Spotify' },
          expiresAt,
        },
      });
      expect(repository.markConversationReplyDelivered(nextSourceUpdateId)).toBe(true);
      expect(repository.getConversationReply(nextSourceUpdateId)).toMatchObject({ status: 'delivered' });
      repository.markProcessed(nextSourceUpdateId);
      expect(repository.getConversationReply(nextSourceUpdateId)).toBeNull();

      repository.upsertConversationSessionWithReply({
        sourceUpdateId: nextSourceUpdateId + 1,
        chatId: '42',
        text: 'Delivered orphan',
        session: {
          telegramUserId: '42',
          flowId: 'flow_abc',
          flowKind: 'transaction',
          step: 'note',
          draft: { amount: '25.00', counterparty: 'Spotify' },
          expiresAt,
        },
      });
      expect(repository.markConversationReplyDelivered(nextSourceUpdateId + 1)).toBe(true);
      nowMs += UPDATE_SEQUENCE_RESET_AFTER_MS + 1;
      repository.preparePolling();
      expect(repository.getConversationReply(nextSourceUpdateId + 1)).toBeNull();
    } finally {
      repository.close();
    }
  });
});
