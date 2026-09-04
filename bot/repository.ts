import { randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  BOT_CURRENCIES,
  BOT_LOCALES,
  ONBOARDING_STAGES,
  type BotCurrency,
  type BotLocale,
  type OnboardingStage,
  type StoredUser,
} from './model.js';

interface EnsureUserInput {
  readonly telegramUserId: string;
  readonly locale: BotLocale;
  readonly primaryCurrency: BotCurrency;
  readonly displayName: string;
}

export interface EnsureUserResult {
  readonly user: StoredUser;
  readonly created: boolean;
}

export interface UserPatch {
  readonly locale?: BotLocale;
  readonly primaryCurrency?: BotCurrency;
  readonly displayName?: string;
  readonly stage?: OnboardingStage;
}

export type PreferenceIntentPatch = UserPatch & (
  | { readonly locale: BotLocale }
  | { readonly primaryCurrency: BotCurrency }
  | { readonly displayName: string }
);

export interface PendingReply {
  readonly sourceUpdateId: number;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly kind: 'custom_name_summary';
}

type Clock = () => Date;

export const PROCESSED_UPDATE_RETENTION_LIMIT = 4_096;
export const UPDATE_SEQUENCE_RESET_AFTER_MS = 6 * 24 * 60 * 60 * 1_000;

function createRevisionEpoch(): string {
  return randomBytes(16).toString('hex');
}

function isRecord(value: unknown): value is Record<string, SQLOutputValue> {
  return typeof value === 'object' && value !== null;
}

function expectString(
  row: Record<string, SQLOutputValue>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid database column: ${key}`);
  return value;
}

function expectNumber(
  row: Record<string, SQLOutputValue>,
  key: string,
): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid database column: ${key}`);
  }
  return value;
}

function rowToUser(row: unknown): StoredUser {
  if (!isRecord(row)) throw new Error('Invalid user row');
  const locale = expectString(row, 'locale');
  const primaryCurrency = expectString(row, 'primary_currency');
  const stage = expectString(row, 'stage');
  if (!(BOT_LOCALES as readonly string[]).includes(locale)) {
    throw new Error('Invalid database locale');
  }
  if (!(BOT_CURRENCIES as readonly string[]).includes(primaryCurrency)) {
    throw new Error('Invalid database currency');
  }
  if (!(ONBOARDING_STAGES as readonly string[]).includes(stage)) {
    throw new Error('Invalid database onboarding stage');
  }
  return {
    telegramUserId: expectString(row, 'telegram_user_id'),
    locale: locale as BotLocale,
    primaryCurrency: primaryCurrency as BotCurrency,
    displayName: expectString(row, 'display_name'),
    revision: expectNumber(row, 'revision'),
    stage: stage as OnboardingStage,
    updatedAt: expectString(row, 'updated_at'),
  };
}

function rowToPendingReply(row: unknown): PendingReply {
  if (!isRecord(row)) throw new Error('Invalid pending reply row');
  const kind = expectString(row, 'kind');
  if (kind !== 'custom_name_summary') throw new Error('Invalid pending reply kind');
  const sourceUpdateId = expectNumber(row, 'source_update_id');
  if (sourceUpdateId < 0) throw new Error('Invalid pending reply update ID');
  return {
    sourceUpdateId,
    telegramUserId: expectString(row, 'telegram_user_id'),
    chatId: expectString(row, 'chat_id'),
    kind,
  };
}

function assertTelegramUserId(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError('Invalid Telegram user ID');
}

function assertDisplayName(value: string): void {
  const length = [...value].length;
  if (length < 1 || length > 48) throw new TypeError('Invalid display name');
}

export class PreferencesRepository {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;
  #closed = false;

  constructor(path: string, clock: Clock = () => new Date()) {
    this.#database = new DatabaseSync(path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    this.#clock = clock;
    const journalRow = this.#database.prepare('PRAGMA journal_mode = WAL').get();
    if (!isRecord(journalRow) || typeof journalRow.journal_mode !== 'string') {
      throw new Error('Could not enable SQLite WAL mode');
    }
    if (path !== ':memory:' && journalRow.journal_mode.toLowerCase() !== 'wal') {
      throw new Error('SQLite WAL mode is required');
    }
    this.#database.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    const versionRow = this.#database.prepare('PRAGMA user_version').get();
    if (!isRecord(versionRow) || typeof versionRow.user_version !== 'number') {
      throw new Error('Could not read SQLite schema version');
    }
    const schemaVersion = versionRow.user_version;
    if (schemaVersion > 2) {
      throw new Error('SQLite schema is newer than this service');
    }
    if (schemaVersion === 0) this.#migrateToVersionTwo();
    if (schemaVersion === 1) this.#migrateFromVersionOneToTwo();
    this.#ensureVersionTwoExtensions();
  }

  getUser(telegramUserId: string): StoredUser | null {
    assertTelegramUserId(telegramUserId);
    const row = this.#database
      .prepare(`
        SELECT telegram_user_id, locale, primary_currency, display_name,
               revision, stage, updated_at
        FROM users
        WHERE telegram_user_id = ?
      `)
      .get(telegramUserId);
    return row === undefined ? null : rowToUser(row);
  }

  ensureUser(input: EnsureUserInput): EnsureUserResult {
    assertTelegramUserId(input.telegramUserId);
    assertDisplayName(input.displayName);
    const existing = this.getUser(input.telegramUserId);
    if (existing !== null) return { user: existing, created: false };

    const updatedAt = this.#clock().toISOString();
    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO users (
          telegram_user_id, locale, primary_currency, display_name,
          revision, stage, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'language', ?)
      `)
      .run(
        input.telegramUserId,
        input.locale,
        input.primaryCurrency,
        input.displayName,
        updatedAt,
      );
    const user = this.getUser(input.telegramUserId);
    if (user === null) throw new Error('Failed to create user preferences');
    return { user, created: result.changes === 1 || result.changes === 1n };
  }

  updateUser(telegramUserId: string, patch: UserPatch): StoredUser {
    assertTelegramUserId(telegramUserId);
    if (patch.displayName !== undefined) assertDisplayName(patch.displayName);
    const current = this.getUser(telegramUserId);
    if (current === null) throw new Error('User preferences not found');

    const nextLocale = patch.locale ?? current.locale;
    const nextCurrency = patch.primaryCurrency ?? current.primaryCurrency;
    const nextName = patch.displayName ?? current.displayName;
    const nextStage = patch.stage ?? current.stage;
    const preferencesChanged =
      nextLocale !== current.locale ||
      nextCurrency !== current.primaryCurrency ||
      nextName !== current.displayName;
    const stageChanged = nextStage !== current.stage;
    if (!preferencesChanged && !stageChanged) return current;
    if (preferencesChanged && current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error('Preference revision overflow');
    }

    const revision = current.revision + (preferencesChanged ? 1 : 0);
    this.#database
      .prepare(`
        UPDATE users
        SET locale = ?, primary_currency = ?, display_name = ?,
            revision = ?, stage = ?, updated_at = ?
        WHERE telegram_user_id = ?
      `)
      .run(
        nextLocale,
        nextCurrency,
        nextName,
        revision,
        nextStage,
        this.#clock().toISOString(),
        telegramUserId,
      );
    const updated = this.getUser(telegramUserId);
    if (updated === null) throw new Error('Updated user preferences disappeared');
    return updated;
  }

  applyPreferenceIntent(
    telegramUserId: string,
    patch: PreferenceIntentPatch,
  ): StoredUser {
    assertTelegramUserId(telegramUserId);
    if (patch.displayName !== undefined) assertDisplayName(patch.displayName);
    const current = this.getUser(telegramUserId);
    if (current === null) throw new Error('User preferences not found');
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error('Preference revision overflow');
    }

    this.#database
      .prepare(`
        UPDATE users
        SET locale = ?, primary_currency = ?, display_name = ?,
            revision = ?, stage = ?, updated_at = ?
        WHERE telegram_user_id = ?
      `)
      .run(
        patch.locale ?? current.locale,
        patch.primaryCurrency ?? current.primaryCurrency,
        patch.displayName ?? current.displayName,
        current.revision + 1,
        patch.stage ?? current.stage,
        this.#clock().toISOString(),
        telegramUserId,
      );
    const updated = this.getUser(telegramUserId);
    if (updated === null) throw new Error('Updated user preferences disappeared');
    return updated;
  }

  applyCustomNameIntent(
    telegramUserId: string,
    chatId: string,
    sourceUpdateId: number,
    displayName: string,
  ): StoredUser {
    assertTelegramUserId(telegramUserId);
    assertTelegramUserId(chatId);
    this.#assertUpdateId(sourceUpdateId);
    assertDisplayName(displayName);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.getPendingReply(sourceUpdateId);
      if (pending !== null) {
        if (pending.telegramUserId !== telegramUserId || pending.chatId !== chatId) {
          throw new Error('Pending reply update ID collision');
        }
        const current = this.getUser(telegramUserId);
        if (current === null) throw new Error('User preferences not found');
        this.#database.exec('COMMIT');
        return current;
      }

      const current = this.getUser(telegramUserId);
      if (current === null) throw new Error('User preferences not found');
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Preference revision overflow');
      }
      this.#database
        .prepare(`
          UPDATE users
          SET display_name = ?, revision = ?, stage = 'complete', updated_at = ?
          WHERE telegram_user_id = ?
        `)
        .run(
          displayName,
          current.revision + 1,
          this.#clock().toISOString(),
          telegramUserId,
        );
      this.#database
        .prepare(`
          INSERT INTO pending_replies (
            source_update_id, telegram_user_id, chat_id, kind, created_at
          ) VALUES (?, ?, ?, 'custom_name_summary', ?)
        `)
        .run(sourceUpdateId, telegramUserId, chatId, this.#clock().toISOString());
      const updated = this.getUser(telegramUserId);
      if (updated === null) throw new Error('Updated user preferences disappeared');
      this.#database.exec('COMMIT');
      return updated;
    } catch (error) {
      this.#rollback(error, 'Custom name transaction rollback failed');
    }
  }

  getPendingReply(sourceUpdateId: number): PendingReply | null {
    this.#assertUpdateId(sourceUpdateId);
    const row = this.#database
      .prepare(`
        SELECT source_update_id, telegram_user_id, chat_id, kind
        FROM pending_replies
        WHERE source_update_id = ?
      `)
      .get(sourceUpdateId);
    return row === undefined ? null : rowToPendingReply(row);
  }

  listPendingReplies(limit = 50): readonly PendingReply[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Invalid pending reply limit');
    }
    return this.#database
      .prepare(`
        SELECT source_update_id, telegram_user_id, chat_id, kind
        FROM pending_replies
        ORDER BY created_at, source_update_id
        LIMIT ?
      `)
      .all(limit)
      .map(rowToPendingReply);
  }

  completePendingReply(sourceUpdateId: number): boolean {
    this.#assertUpdateId(sourceUpdateId);
    const result = this.#database
      .prepare('DELETE FROM pending_replies WHERE source_update_id = ?')
      .run(sourceUpdateId);
    return result.changes === 1 || result.changes === 1n;
  }

  hasProcessedUpdate(updateId: number): boolean {
    this.#assertUpdateId(updateId);
    return this.#database
      .prepare('SELECT 1 AS present FROM processed_updates WHERE update_id = ?')
      .get(updateId) !== undefined;
  }

  markProcessed(updateId: number): boolean {
    this.#assertUpdateId(updateId);
    if (updateId === Number.MAX_SAFE_INTEGER) {
      throw new Error('Update offset overflow');
    }
    const now = this.#clock();
    const processedAt = now.toISOString();
    const processedAtMs = this.#dateToMilliseconds(now);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database
        .prepare(`
          INSERT OR IGNORE INTO processed_updates (update_id, processed_at)
          VALUES (?, ?)
        `)
        .run(updateId, processedAt);
      const nextOffset = updateId + 1;
      this.#database
        .prepare(`
          UPDATE service_state
          SET next_update_offset = CASE
            WHEN next_update_offset IS NULL OR next_update_offset < ? THEN ?
            ELSE next_update_offset
          END,
          last_update_at_ms = CASE
            WHEN last_update_at_ms IS NULL OR last_update_at_ms < ? THEN ?
            ELSE last_update_at_ms
          END
          WHERE singleton = 1
        `)
        .run(nextOffset, nextOffset, processedAtMs, processedAtMs);
      const nextWatermark = this.#readUpdateWatermark();
      if (nextWatermark === null) throw new Error('Update watermark disappeared');
      this.#pruneProcessedUpdates(nextWatermark);
      this.#database.exec('COMMIT');
      return result.changes === 1 || result.changes === 1n;
    } catch (error) {
      this.#rollback(error, 'Processed update transaction rollback failed');
    }
  }

  nextUpdateOffset(): number | undefined {
    return this.#readUpdateWatermark() ?? undefined;
  }

  preparePolling(): number | undefined {
    const nowMs = this.#dateToMilliseconds(this.#clock());
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare(`
          SELECT next_update_offset, last_update_at_ms
          FROM service_state
          WHERE singleton = 1
        `)
        .get();
      if (!isRecord(row)) throw new Error('Invalid polling state row');
      const lastUpdateAtMs = row.last_update_at_ms;
      if (
        lastUpdateAtMs !== null &&
        (typeof lastUpdateAtMs !== 'number' ||
          !Number.isSafeInteger(lastUpdateAtMs) ||
          lastUpdateAtMs < 0)
      ) {
        throw new Error('Invalid last update timestamp');
      }
      const lastProcessedAtMs = this.#lastProcessedAtMilliseconds();
      const effectiveLastUpdateAtMs = lastProcessedAtMs !== null &&
        (lastUpdateAtMs === null || lastProcessedAtMs > lastUpdateAtMs)
        ? lastProcessedAtMs
        : lastUpdateAtMs;
      if (effectiveLastUpdateAtMs !== lastUpdateAtMs) {
        this.#database
          .prepare(`
            UPDATE service_state
            SET last_update_at_ms = ?
            WHERE singleton = 1
          `)
          .run(effectiveLastUpdateAtMs);
      }
      if (
        effectiveLastUpdateAtMs !== null &&
        nowMs >= effectiveLastUpdateAtMs &&
        nowMs - effectiveLastUpdateAtMs >= UPDATE_SEQUENCE_RESET_AFTER_MS
      ) {
        this.#database.exec(`
          DELETE FROM processed_updates;
          UPDATE service_state
          SET next_update_offset = NULL, last_update_at_ms = NULL
          WHERE singleton = 1;
        `);
        this.#database.exec('COMMIT');
        return undefined;
      }
      const offset = this.#readUpdateWatermark();
      this.#database.exec('COMMIT');
      return offset ?? undefined;
    } catch (error) {
      this.#rollback(error, 'Polling state transaction rollback failed');
    }
  }

  revisionEpoch(): string {
    const row = this.#database
      .prepare('SELECT revision_epoch FROM service_state WHERE singleton = 1')
      .get();
    if (!isRecord(row) || typeof row.revision_epoch !== 'string') {
      throw new Error('Invalid revision epoch row');
    }
    if (!/^[0-9a-f]{32}$/.test(row.revision_epoch)) {
      throw new Error('Invalid revision epoch');
    }
    return row.revision_epoch;
  }

  ping(): boolean {
    const row = this.#database.prepare('SELECT 1 AS ok').get();
    return isRecord(row) && row.ok === 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertUpdateId(updateId: number): void {
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      throw new TypeError('Invalid Telegram update ID');
    }
  }

  #dateToMilliseconds(value: Date): number {
    const milliseconds = value.getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('Invalid repository clock');
    }
    return milliseconds;
  }

  #lastProcessedAtMilliseconds(): number | null {
    const row = this.#database
      .prepare('SELECT MAX(processed_at) AS processed_at FROM processed_updates')
      .get();
    if (!isRecord(row)) throw new Error('Invalid processed update timestamp row');
    if (row.processed_at === null) return null;
    if (typeof row.processed_at !== 'string') {
      throw new Error('Invalid processed update timestamp');
    }
    const milliseconds = Date.parse(row.processed_at);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('Invalid processed update timestamp');
    }
    return milliseconds;
  }

  #readUpdateWatermark(): number | null {
    const row = this.#database
      .prepare(`
        SELECT next_update_offset
        FROM service_state
        WHERE singleton = 1
      `)
      .get();
    if (!isRecord(row)) throw new Error('Invalid update watermark row');
    const value = row.next_update_offset;
    if (value === null) return null;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error('Invalid persisted update offset');
    }
    return value;
  }

  #pruneProcessedUpdates(watermark: number): void {
    this.#database
      .prepare(`
        DELETE FROM processed_updates
        WHERE update_id < ?
          AND update_id < (
            SELECT update_id
            FROM processed_updates
            ORDER BY update_id DESC
            LIMIT 1 OFFSET ?
          )
      `)
      .run(watermark, PROCESSED_UPDATE_RETENTION_LIMIT - 1);
  }

  #rollback(error: unknown, message: string): never {
    try {
      this.#database.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        message,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  #migrateToVersionTwo(): void {
    const revisionEpoch = createRevisionEpoch();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec(`
        CREATE TABLE users (
          telegram_user_id TEXT PRIMARY KEY
            CHECK (
              length(telegram_user_id) > 0
              AND substr(telegram_user_id, 1, 1) != '0'
              AND telegram_user_id NOT GLOB '*[^0-9]*'
            ),
          locale TEXT NOT NULL CHECK (locale IN ('ru', 'en')),
          primary_currency TEXT NOT NULL
            CHECK (primary_currency IN ('KZT', 'THB', 'VND', 'RUB', 'USD', 'EUR', 'IDR', 'GEL')),
          display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 48),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          stage TEXT NOT NULL
            CHECK (stage IN ('language', 'currency', 'custom_name', 'complete')),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE processed_updates (
          update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
          processed_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE service_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_update_offset INTEGER
            CHECK (
              next_update_offset IS NULL
              OR next_update_offset BETWEEN 1 AND 9007199254740991
            ),
          last_update_at_ms INTEGER
            CHECK (
              last_update_at_ms IS NULL
              OR last_update_at_ms BETWEEN 0 AND 9007199254740991
            ),
          revision_epoch TEXT NOT NULL
            CHECK (
              length(revision_epoch) = 32
              AND revision_epoch NOT GLOB '*[^0-9a-f]*'
            )
        ) STRICT;

        CREATE TABLE pending_replies (
          source_update_id INTEGER PRIMARY KEY
            CHECK (source_update_id BETWEEN 0 AND 9007199254740991),
          telegram_user_id TEXT NOT NULL REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL
            CHECK (
              length(chat_id) > 0
              AND substr(chat_id, 1, 1) != '0'
              AND chat_id NOT GLOB '*[^0-9]*'
            ),
          kind TEXT NOT NULL CHECK (kind IN ('custom_name_summary')),
          created_at TEXT NOT NULL
        ) STRICT;

      `);
      this.#database
        .prepare(`
          INSERT INTO service_state (
            singleton, next_update_offset, last_update_at_ms, revision_epoch
          ) VALUES (1, NULL, NULL, ?)
        `)
        .run(revisionEpoch);
      this.#database.exec('PRAGMA user_version = 2; COMMIT;');
    } catch (error) {
      this.#rollback(error, 'SQLite migration rollback failed');
    }
  }

  #migrateFromVersionOneToTwo(): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec(`
        CREATE TABLE service_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_update_offset INTEGER
            CHECK (
              next_update_offset IS NULL
              OR next_update_offset BETWEEN 1 AND 9007199254740991
            )
        ) STRICT;

        INSERT INTO service_state (singleton, next_update_offset)
        SELECT 1, CASE
          WHEN MAX(update_id) IS NULL THEN NULL
          ELSE MAX(update_id) + 1
        END
        FROM processed_updates;
      `);
      const watermark = this.#readUpdateWatermark();
      if (watermark !== null) this.#pruneProcessedUpdates(watermark);
      this.#database.exec('PRAGMA user_version = 2; COMMIT;');
    } catch (error) {
      this.#rollback(error, 'SQLite migration rollback failed');
    }
  }

  #ensureVersionTwoExtensions(): void {
    const serviceStateColumns = new Set(
      this.#database
        .prepare('PRAGMA table_info(service_state)')
        .all()
        .map((row) => isRecord(row) && typeof row.name === 'string' ? row.name : ''),
    );
    const hasLastUpdateAt = serviceStateColumns.has('last_update_at_ms');
    const hasRevisionEpoch = serviceStateColumns.has('revision_epoch');
    const hasPendingReplies = this.#database
      .prepare(`
        SELECT 1 AS present
        FROM sqlite_schema
        WHERE type = 'table' AND name = 'pending_replies'
      `)
      .get() !== undefined;
    if (hasLastUpdateAt && hasRevisionEpoch && hasPendingReplies) {
      this.revisionEpoch();
      return;
    }

    const revisionEpoch = createRevisionEpoch();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!hasLastUpdateAt) {
        this.#database.exec(`
          ALTER TABLE service_state
          ADD COLUMN last_update_at_ms INTEGER
            CHECK (
              last_update_at_ms IS NULL
              OR last_update_at_ms BETWEEN 0 AND 9007199254740991
            );
        `);
      }
      if (!hasRevisionEpoch) {
        this.#database.exec(`
          ALTER TABLE service_state
          ADD COLUMN revision_epoch TEXT
            CHECK (
              revision_epoch IS NULL
              OR (
                length(revision_epoch) = 32
                AND revision_epoch NOT GLOB '*[^0-9a-f]*'
              )
            );
        `);
      }
      this.#database
        .prepare(`
          UPDATE service_state
          SET last_update_at_ms = COALESCE(last_update_at_ms, ?),
              revision_epoch = COALESCE(revision_epoch, ?)
          WHERE singleton = 1
        `)
        .run(this.#lastProcessedAtMilliseconds(), revisionEpoch);
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS pending_replies (
          source_update_id INTEGER PRIMARY KEY
            CHECK (source_update_id BETWEEN 0 AND 9007199254740991),
          telegram_user_id TEXT NOT NULL REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL
            CHECK (
              length(chat_id) > 0
              AND substr(chat_id, 1, 1) != '0'
              AND chat_id NOT GLOB '*[^0-9]*'
            ),
          kind TEXT NOT NULL CHECK (kind IN ('custom_name_summary')),
          created_at TEXT NOT NULL
        ) STRICT;
      `);
      this.revisionEpoch();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#rollback(error, 'SQLite extension rollback failed');
    }
  }

}
