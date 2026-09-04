import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
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
});
