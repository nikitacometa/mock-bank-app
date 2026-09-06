import { randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { canonicalJson, canonicalJsonDigest, sha256Hex } from './canonical-json.js';
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

export type LedgerMode = 'local' | 'server';
export type BankOperationSource = 'import' | 'telegram' | 'tma' | 'system';

export interface StoredBankState {
  readonly telegramUserId: string;
  readonly state: unknown;
  readonly stateJson: string;
  readonly digest: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface BankOutboxItem {
  readonly id: number;
  readonly bankOperationId: number;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly messageKind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: string;
}

export interface ConversationSession {
  readonly telegramUserId: string;
  readonly flowId: string;
  readonly flowKind: 'transaction' | 'accounts' | 'recurring' | 'delete_demo';
  readonly step: string;
  readonly draft: unknown;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface ConversationReply {
  readonly sourceUpdateId: number;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly text: string;
  readonly replyMarkup: unknown | null;
  readonly status: 'pending' | 'delivered';
  readonly updateProcessed: boolean;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface ConversationSessionReplyInput {
  readonly sourceUpdateId: number;
  readonly chatId: string;
  readonly text: string;
  readonly replyMarkup?: unknown;
  readonly session: Omit<ConversationSession, 'updatedAt'>;
}

export interface ImportBankStateInput {
  readonly telegramUserId: string;
  readonly operationId: string;
  readonly commandHash: string;
  readonly stateJson: string;
  readonly outcome: unknown;
}

export interface ExecuteBankOperationInput {
  readonly telegramUserId: string;
  readonly sourceKind: Exclude<BankOperationSource, 'import'>;
  readonly operationId: string;
  readonly commandHash: string;
  readonly operationKind: string;
  readonly chatId?: string;
}

export interface BankStateTransition {
  readonly stateJson: string;
  readonly outcome: unknown;
  readonly outbox?: {
    readonly messageKind: string;
    readonly payload: unknown;
  };
}

export interface BankOperationResult {
  readonly replayed: boolean;
  readonly operationId: number;
  readonly operationRevision: number;
  readonly state: StoredBankState;
  readonly outcome: unknown;
}

export interface BankMutationResult {
  readonly changed: boolean;
  readonly state: StoredBankState;
  readonly outcome: unknown;
}

export class BankIdempotencyConflictError extends Error {
  constructor() {
    super('Bank operation idempotency conflict');
    this.name = 'BankIdempotencyConflictError';
  }
}

export class BankStateAlreadyExistsError extends Error {
  constructor() {
    super('Bank state already exists');
    this.name = 'BankStateAlreadyExistsError';
  }
}

export class BankStateMissingError extends Error {
  constructor() {
    super('Bank state does not exist');
    this.name = 'BankStateMissingError';
  }
}

export class BankOperationCapacityError extends Error {
  constructor() {
    super('Bank operation history is full');
    this.name = 'BankOperationCapacityError';
  }
}

export class BankStateCapacityError extends Error {
  constructor() {
    super('Bank state is too large');
    this.name = 'BankStateCapacityError';
  }
}

type Clock = () => Date;

export interface RepositoryLimits {
  readonly maxBankOperationsPerUser?: number;
}

export const PROCESSED_UPDATE_RETENTION_LIMIT = 4_096;
export const BANK_OPERATION_RETENTION_LIMIT = 8_192;
export const UPDATE_SEQUENCE_RESET_AFTER_MS = 6 * 24 * 60 * 60 * 1_000;
export const MAX_BANK_STATE_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_BANK_OUTCOME_JSON_BYTES = 64 * 1024;
export const MAX_CONVERSATION_DRAFT_JSON_BYTES = 32 * 1024;
export const MAX_CONVERSATION_REPLY_MARKUP_JSON_BYTES = 32 * 1024;

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

function parseStoredJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

function rowToBankState(row: unknown): StoredBankState {
  if (!isRecord(row)) throw new Error('Invalid bank state row');
  const stateJson = expectString(row, 'state_json');
  const digest = expectString(row, 'state_digest');
  if (!/^[0-9a-f]{64}$/.test(digest) || sha256Hex(stateJson) !== digest) {
    throw new Error('Invalid bank state digest');
  }
  const revision = expectNumber(row, 'revision');
  if (revision < 1) throw new Error('Invalid bank state revision');
  return {
    telegramUserId: expectString(row, 'telegram_user_id'),
    state: parseStoredJson(stateJson, 'bank state'),
    stateJson,
    digest,
    revision,
    updatedAt: expectString(row, 'updated_at'),
  };
}

function rowToBankOutbox(row: unknown): BankOutboxItem {
  if (!isRecord(row)) throw new Error('Invalid bank outbox row');
  const id = expectNumber(row, 'id');
  const bankOperationId = expectNumber(row, 'bank_operation_id');
  if (id < 1 || bankOperationId < 1) throw new Error('Invalid bank outbox ID');
  const payloadJson = expectString(row, 'payload_json');
  const attempts = expectNumber(row, 'attempts');
  const nextAttemptAt = expectNumber(row, 'next_attempt_at');
  if (attempts < 0 || attempts > 31 || nextAttemptAt < 0) {
    throw new Error('Invalid bank outbox retry state');
  }
  return {
    id,
    bankOperationId,
    telegramUserId: expectString(row, 'telegram_user_id'),
    chatId: expectString(row, 'chat_id'),
    messageKind: expectString(row, 'message_kind'),
    payload: parseStoredJson(payloadJson, 'bank outbox payload'),
    attempts,
    nextAttemptAt,
    createdAt: expectString(row, 'created_at'),
  };
}

function rowToConversationSession(row: unknown): ConversationSession {
  if (!isRecord(row)) throw new Error('Invalid conversation session row');
  const flowKind = expectString(row, 'flow_kind');
  if (!['transaction', 'accounts', 'recurring', 'delete_demo'].includes(flowKind)) {
    throw new Error('Invalid conversation flow kind');
  }
  return {
    telegramUserId: expectString(row, 'telegram_user_id'),
    flowId: expectString(row, 'flow_id'),
    flowKind: flowKind as ConversationSession['flowKind'],
    step: expectString(row, 'step'),
    draft: parseStoredJson(expectString(row, 'draft_json'), 'conversation draft'),
    expiresAt: expectString(row, 'expires_at'),
    updatedAt: expectString(row, 'updated_at'),
  };
}

function rowToConversationReply(row: unknown): ConversationReply {
  if (!isRecord(row)) throw new Error('Invalid conversation reply row');
  const sourceUpdateId = expectNumber(row, 'source_update_id');
  if (sourceUpdateId < 0) throw new Error('Invalid conversation reply update ID');
  const status = expectString(row, 'status');
  if (status !== 'pending' && status !== 'delivered') {
    throw new Error('Invalid conversation reply status');
  }
  const replyMarkupJson = row.reply_markup_json;
  if (replyMarkupJson !== null && typeof replyMarkupJson !== 'string') {
    throw new Error('Invalid conversation reply markup');
  }
  const deliveredAt = row.delivered_at;
  if (deliveredAt !== null && typeof deliveredAt !== 'string') {
    throw new Error('Invalid conversation reply delivery timestamp');
  }
  if ((status === 'pending') !== (deliveredAt === null)) {
    throw new Error('Invalid conversation reply delivery state');
  }
  const updateProcessed = expectNumber(row, 'update_processed');
  if (updateProcessed !== 0 && updateProcessed !== 1) {
    throw new Error('Invalid conversation reply processed state');
  }
  return {
    sourceUpdateId,
    telegramUserId: expectString(row, 'telegram_user_id'),
    chatId: expectString(row, 'chat_id'),
    text: expectString(row, 'text'),
    replyMarkup: replyMarkupJson === null
      ? null
      : parseStoredJson(replyMarkupJson, 'conversation reply markup'),
    status,
    updateProcessed: updateProcessed === 1,
    createdAt: expectString(row, 'created_at'),
    deliveredAt,
  };
}

function assertTelegramUserId(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError('Invalid Telegram user ID');
}

function assertDisplayName(value: string): void {
  const length = [...value].length;
  if (length < 1 || length > 48) throw new TypeError('Invalid display name');
}

function assertOperationId(value: string): void {
  if (!/^[A-Za-z0-9:_-]{1,96}$/.test(value)) {
    throw new TypeError('Invalid bank operation ID');
  }
}

function assertCommandHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('Invalid bank command hash');
}

function assertBankOperationSource(value: string): asserts value is BankOperationSource {
  if (!['import', 'telegram', 'tma', 'system'].includes(value)) {
    throw new TypeError('Invalid bank operation source');
  }
}

function assertShortIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_:-]{0,63}$/.test(value)) throw new TypeError(`Invalid ${label}`);
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertJsonByteLength(value: string, maximum: number, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > maximum) throw new RangeError(`${label} is too large`);
}

function normalizeStateJson(value: string): { readonly json: string; readonly digest: string } {
  if (Buffer.byteLength(value, 'utf8') > MAX_BANK_STATE_JSON_BYTES) {
    throw new BankStateCapacityError();
  }
  const parsed = parseStoredJson(value, 'bank state');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Bank state must be a JSON object');
  }
  // Re-serialize through the canonical boundary so equivalent states have one digest.
  const json = canonicalJson(parsed);
  if (Buffer.byteLength(json, 'utf8') > MAX_BANK_STATE_JSON_BYTES) {
    throw new BankStateCapacityError();
  }
  return { json, digest: sha256Hex(json) };
}

function normalizeBoundedJson(
  value: unknown,
  maximum: number,
  label: string,
): string {
  const json = canonicalJson(value);
  assertJsonByteLength(json, maximum, label);
  return json;
}

export class PreferencesRepository {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;
  readonly #maxBankOperationsPerUser: number;
  #closed = false;

  constructor(
    path: string,
    clock: Clock = () => new Date(),
    limits: RepositoryLimits = {},
  ) {
    const maxBankOperationsPerUser =
      limits.maxBankOperationsPerUser ?? BANK_OPERATION_RETENTION_LIMIT;
    if (!Number.isSafeInteger(maxBankOperationsPerUser) || maxBankOperationsPerUser < 1) {
      throw new TypeError('Invalid bank operation retention limit');
    }
    this.#database = new DatabaseSync(path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    this.#clock = clock;
    this.#maxBankOperationsPerUser = maxBankOperationsPerUser;
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

  ledgerMode(): LedgerMode {
    const row = this.#database
      .prepare('SELECT ledger_mode FROM service_state WHERE singleton = 1')
      .get();
    if (!isRecord(row) || (row.ledger_mode !== 'local' && row.ledger_mode !== 'server')) {
      throw new Error('Invalid ledger service mode');
    }
    return row.ledger_mode;
  }

  setLedgerMode(mode: LedgerMode): void {
    if (mode !== 'local' && mode !== 'server') throw new TypeError('Invalid ledger service mode');
    this.#database
      .prepare('UPDATE service_state SET ledger_mode = ? WHERE singleton = 1')
      .run(mode);
    if (this.ledgerMode() !== mode) throw new Error('Ledger service mode update failed');
  }

  getBankState(telegramUserId: string): StoredBankState | null {
    assertTelegramUserId(telegramUserId);
    const row = this.#database
      .prepare(`
        SELECT telegram_user_id, state_json, state_digest, revision, updated_at
        FROM bank_states
        WHERE telegram_user_id = ?
      `)
      .get(telegramUserId);
    return row === undefined ? null : rowToBankState(row);
  }

  replayBankOperation(
    telegramUserId: string,
    sourceKind: BankOperationSource,
    operationId: string,
    commandHash: string,
  ): BankOperationResult | null {
    assertTelegramUserId(telegramUserId);
    assertBankOperationSource(sourceKind);
    assertOperationId(operationId);
    assertCommandHash(commandHash);
    this.#database.exec('BEGIN');
    try {
      const replay = this.#replayBankOperation(
        telegramUserId,
        sourceKind,
        operationId,
        commandHash,
      );
      this.#database.exec('COMMIT');
      return replay;
    } catch (error) {
      this.#rollback(error, 'Bank replay transaction rollback failed');
    }
  }

  isExactBankOperation(
    telegramUserId: string,
    sourceKind: BankOperationSource,
    operationId: string,
    commandHash: string,
  ): boolean {
    assertTelegramUserId(telegramUserId);
    assertBankOperationSource(sourceKind);
    assertOperationId(operationId);
    assertCommandHash(commandHash);
    const row = this.#database
      .prepare(`
        SELECT command_hash
        FROM bank_operations
        WHERE telegram_user_id = ? AND source_kind = ? AND operation_id = ?
      `)
      .get(telegramUserId, sourceKind, operationId);
    if (row === undefined) return false;
    if (!isRecord(row)) throw new Error('Invalid bank operation row');
    return expectString(row, 'command_hash') === commandHash;
  }

  hasBankOperation(
    telegramUserId: string,
    sourceKind: BankOperationSource,
    operationId: string,
  ): boolean {
    assertTelegramUserId(telegramUserId);
    assertBankOperationSource(sourceKind);
    assertOperationId(operationId);
    return this.#database
      .prepare(`
        SELECT 1
        FROM bank_operations
        WHERE telegram_user_id = ? AND source_kind = ? AND operation_id = ?
      `)
      .get(telegramUserId, sourceKind, operationId) !== undefined;
  }

  importBankState(input: ImportBankStateInput): BankOperationResult {
    assertTelegramUserId(input.telegramUserId);
    assertOperationId(input.operationId);
    assertCommandHash(input.commandHash);
    const normalizedState = normalizeStateJson(input.stateJson);
    const outcomeJson = normalizeBoundedJson(
      input.outcome,
      MAX_BANK_OUTCOME_JSON_BYTES,
      'Bank operation outcome',
    );

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.#replayBankOperation(
        input.telegramUserId,
        'import',
        input.operationId,
        input.commandHash,
      );
      if (replay !== null) {
        this.#database.exec('COMMIT');
        return replay;
      }
      if (this.getBankState(input.telegramUserId) !== null) {
        throw new BankStateAlreadyExistsError();
      }

      const now = this.#clock().toISOString();
      this.#database
        .prepare(`
          INSERT INTO bank_states (
            telegram_user_id, state_json, state_digest, revision, updated_at
          ) VALUES (?, ?, ?, 1, ?)
        `)
        .run(input.telegramUserId, normalizedState.json, normalizedState.digest, now);
      const operationId = this.#insertBankOperation({
        telegramUserId: input.telegramUserId,
        sourceKind: 'import',
        operationId: input.operationId,
        commandHash: input.commandHash,
        operationKind: 'bank_import',
        outcomeJson,
        bankRevision: 1,
        createdAt: now,
      });
      const state = this.getBankState(input.telegramUserId);
      if (state === null) throw new Error('Imported bank state disappeared');
      this.#database.exec('COMMIT');
      return {
        replayed: false,
        operationId,
        operationRevision: 1,
        state,
        outcome: parseStoredJson(outcomeJson, 'bank operation outcome'),
      };
    } catch (error) {
      this.#rollback(error, 'Bank import transaction rollback failed');
    }
  }

  executeBankOperation(
    input: ExecuteBankOperationInput,
    transition: (state: unknown) => BankStateTransition,
  ): BankOperationResult {
    assertTelegramUserId(input.telegramUserId);
    assertOperationId(input.operationId);
    assertCommandHash(input.commandHash);
    assertBankOperationSource(input.sourceKind);
    assertShortIdentifier(input.operationKind, 'bank operation kind');
    if (input.chatId !== undefined) assertTelegramUserId(input.chatId);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.#replayBankOperation(
        input.telegramUserId,
        input.sourceKind,
        input.operationId,
        input.commandHash,
      );
      if (replay !== null) {
        this.#database.exec('COMMIT');
        return replay;
      }
      this.#makeRoomForFreshUserOperation(input.telegramUserId, input.sourceKind);
      const current = this.getBankState(input.telegramUserId);
      if (current === null) throw new BankStateMissingError();
      const transitionResult = transition(current.state);
      const normalizedState = normalizeStateJson(transitionResult.stateJson);
      const outcomeJson = normalizeBoundedJson(
        transitionResult.outcome,
        MAX_BANK_OUTCOME_JSON_BYTES,
        'Bank operation outcome',
      );
      let revision = current.revision;
      const changed = normalizedState.json !== current.stateJson;
      if (changed) {
        if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Bank revision overflow');
        revision += 1;
        this.#database
          .prepare(`
            UPDATE bank_states
            SET state_json = ?, state_digest = ?, revision = ?, updated_at = ?
            WHERE telegram_user_id = ? AND revision = ?
          `)
          .run(
            normalizedState.json,
            normalizedState.digest,
            revision,
            this.#clock().toISOString(),
            input.telegramUserId,
            current.revision,
          );
      }
      const createdAt = this.#clock().toISOString();
      const operationId = this.#insertBankOperation({
        ...input,
        outcomeJson,
        bankRevision: revision,
        createdAt,
      });
      if (transitionResult.outbox !== undefined) {
        if (input.chatId === undefined) throw new Error('Bank outbox requires a chat ID');
        this.#insertBankOutbox({
          bankOperationId: operationId,
          telegramUserId: input.telegramUserId,
          chatId: input.chatId,
          messageKind: transitionResult.outbox.messageKind,
          payload: transitionResult.outbox.payload,
          createdAt,
        });
      }
      const state = this.getBankState(input.telegramUserId);
      if (state === null) throw new Error('Updated bank state disappeared');
      this.#database.exec('COMMIT');
      return {
        replayed: false,
        operationId,
        operationRevision: revision,
        state,
        outcome: parseStoredJson(outcomeJson, 'bank operation outcome'),
      };
    } catch (error) {
      this.#rollback(error, 'Bank operation transaction rollback failed');
    }
  }

  mutateBankState(
    telegramUserId: string,
    transition: (state: unknown) => BankStateTransition,
  ): BankMutationResult {
    assertTelegramUserId(telegramUserId);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getBankState(telegramUserId);
      if (current === null) throw new BankStateMissingError();
      const transitionResult = transition(current.state);
      const normalizedState = normalizeStateJson(transitionResult.stateJson);
      const changed = normalizedState.json !== current.stateJson;
      if (transitionResult.outbox !== undefined && !changed) {
        throw new Error('Materialization outbox requires a state change');
      }
      const outcomeJson = normalizeBoundedJson(
        transitionResult.outcome,
        MAX_BANK_OUTCOME_JSON_BYTES,
        'Bank mutation outcome',
      );
      let revision = current.revision;
      if (changed) {
        if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Bank revision overflow');
        revision += 1;
        this.#database
          .prepare(`
            UPDATE bank_states
            SET state_json = ?, state_digest = ?, revision = ?, updated_at = ?
            WHERE telegram_user_id = ? AND revision = ?
          `)
          .run(
            normalizedState.json,
            normalizedState.digest,
            revision,
            this.#clock().toISOString(),
            telegramUserId,
            current.revision,
          );
      }
      if (transitionResult.outbox !== undefined) {
        const createdAt = this.#clock().toISOString();
        const operationId = this.#insertBankOperation({
          telegramUserId,
          sourceKind: 'system',
          operationId: `materialize:${revision}`,
          commandHash: canonicalJsonDigest({
            kind: 'materialize_recurring',
            revision,
            payload: transitionResult.outbox.payload,
          }),
          operationKind: 'materialize_recurring',
          outcomeJson,
          bankRevision: revision,
          createdAt,
        });
        this.#insertBankOutbox({
          bankOperationId: operationId,
          telegramUserId,
          chatId: telegramUserId,
          messageKind: transitionResult.outbox.messageKind,
          payload: transitionResult.outbox.payload,
          createdAt,
        });
      }
      const state = this.getBankState(telegramUserId);
      if (state === null) throw new Error('Materialized bank state disappeared');
      this.#database.exec('COMMIT');
      return { changed, state, outcome: transitionResult.outcome };
    } catch (error) {
      this.#rollback(error, 'Bank state mutation rollback failed');
    }
  }

  getConversationSession(telegramUserId: string): ConversationSession | null {
    assertTelegramUserId(telegramUserId);
    const row = this.#database
      .prepare(`
        SELECT telegram_user_id, flow_id, flow_kind, step,
               draft_json, expires_at, updated_at
        FROM conversation_sessions
        WHERE telegram_user_id = ?
      `)
      .get(telegramUserId);
    if (row === undefined) return null;
    const session = rowToConversationSession(row);
    if (session.expiresAt > this.#clock().toISOString()) return session;
    this.#database
      .prepare(`
        DELETE FROM conversation_sessions
        WHERE telegram_user_id = ? AND flow_id = ? AND expires_at = ?
      `)
      .run(telegramUserId, session.flowId, session.expiresAt);
    return null;
  }

  hasConversationSessionRecord(telegramUserId: string): boolean {
    assertTelegramUserId(telegramUserId);
    return this.#database
      .prepare('SELECT 1 AS present FROM conversation_sessions WHERE telegram_user_id = ?')
      .get(telegramUserId) !== undefined;
  }

  upsertConversationSession(
    session: Omit<ConversationSession, 'updatedAt'>,
  ): ConversationSession {
    assertTelegramUserId(session.telegramUserId);
    assertShortIdentifier(session.flowId, 'conversation flow ID');
    assertShortIdentifier(session.step, 'conversation step');
    assertIsoTimestamp(session.expiresAt, 'conversation expiry');
    const now = this.#clock();
    const expiresAtMs = Date.parse(session.expiresAt);
    if (expiresAtMs <= now.getTime() || expiresAtMs - now.getTime() > 24 * 60 * 60 * 1_000) {
      throw new RangeError('Conversation expiry must be within the next 24 hours');
    }
    const draftJson = normalizeBoundedJson(
      session.draft,
      MAX_CONVERSATION_DRAFT_JSON_BYTES,
      'Conversation draft',
    );
    this.#database
      .prepare(`
        INSERT INTO conversation_sessions (
          telegram_user_id, flow_id, flow_kind, step,
          draft_json, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          flow_id = excluded.flow_id,
          flow_kind = excluded.flow_kind,
          step = excluded.step,
          draft_json = excluded.draft_json,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(
        session.telegramUserId,
        session.flowId,
        session.flowKind,
        session.step,
        draftJson,
        session.expiresAt,
        now.toISOString(),
      );
    const stored = this.getConversationSession(session.telegramUserId);
    if (stored === null) throw new Error('Conversation session disappeared');
    return stored;
  }

  upsertConversationSessionWithReply(
    input: ConversationSessionReplyInput,
  ): ConversationReply {
    this.#assertUpdateId(input.sourceUpdateId);
    assertTelegramUserId(input.chatId);
    assertTelegramUserId(input.session.telegramUserId);
    if (input.chatId !== input.session.telegramUserId) {
      throw new TypeError('Conversation replies require the user private chat');
    }
    assertShortIdentifier(input.session.flowId, 'conversation flow ID');
    assertShortIdentifier(input.session.step, 'conversation step');
    assertIsoTimestamp(input.session.expiresAt, 'conversation expiry');
    const textLength = [...input.text].length;
    if (textLength < 1 || textLength > 4_096) {
      throw new RangeError('Conversation reply text must contain 1 to 4096 characters');
    }
    const now = this.#clock();
    const expiresAtMs = Date.parse(input.session.expiresAt);
    if (expiresAtMs <= now.getTime() || expiresAtMs - now.getTime() > 24 * 60 * 60 * 1_000) {
      throw new RangeError('Conversation expiry must be within the next 24 hours');
    }
    const draftJson = normalizeBoundedJson(
      input.session.draft,
      MAX_CONVERSATION_DRAFT_JSON_BYTES,
      'Conversation draft',
    );
    const replyMarkupJson = input.replyMarkup === undefined
      ? null
      : normalizeBoundedJson(
          input.replyMarkup,
          MAX_CONVERSATION_REPLY_MARKUP_JSON_BYTES,
          'Conversation reply markup',
        );

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getConversationReply(input.sourceUpdateId);
      if (existing !== null) {
        if (
          existing.telegramUserId !== input.session.telegramUserId ||
          existing.chatId !== input.chatId
        ) {
          throw new Error('Conversation reply update ID collision');
        }
        this.#database.exec('COMMIT');
        return existing;
      }
      const createdAt = now.toISOString();
      this.#database
        .prepare(`
          INSERT INTO conversation_sessions (
            telegram_user_id, flow_id, flow_kind, step,
            draft_json, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_user_id) DO UPDATE SET
            flow_id = excluded.flow_id,
            flow_kind = excluded.flow_kind,
            step = excluded.step,
            draft_json = excluded.draft_json,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `)
        .run(
          input.session.telegramUserId,
          input.session.flowId,
          input.session.flowKind,
          input.session.step,
          draftJson,
          input.session.expiresAt,
          createdAt,
        );
      this.#database
        .prepare(`
          INSERT INTO conversation_replies (
            source_update_id, telegram_user_id, chat_id, text,
            reply_markup_json, status, update_processed, created_at, delivered_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL)
        `)
        .run(
          input.sourceUpdateId,
          input.session.telegramUserId,
          input.chatId,
          input.text,
          replyMarkupJson,
          createdAt,
        );
      const reply = this.getConversationReply(input.sourceUpdateId);
      if (reply === null) throw new Error('Conversation reply disappeared');
      this.#database.exec('COMMIT');
      return reply;
    } catch (error) {
      this.#rollback(error, 'Conversation session reply transaction rollback failed');
    }
  }

  getConversationReply(sourceUpdateId: number): ConversationReply | null {
    this.#assertUpdateId(sourceUpdateId);
    const row = this.#database
      .prepare(`
        SELECT source_update_id, telegram_user_id, chat_id, text,
               reply_markup_json, status, update_processed, created_at, delivered_at
        FROM conversation_replies
        WHERE source_update_id = ?
      `)
      .get(sourceUpdateId);
    return row === undefined ? null : rowToConversationReply(row);
  }

  listPendingConversationReplies(limit = 50): readonly ConversationReply[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Invalid conversation reply limit');
    }
    return this.#database
      .prepare(`
        SELECT source_update_id, telegram_user_id, chat_id, text,
               reply_markup_json, status, update_processed, created_at, delivered_at
        FROM conversation_replies
        WHERE status = 'pending'
        ORDER BY created_at, source_update_id
        LIMIT ?
      `)
      .all(limit)
      .map(rowToConversationReply);
  }

  getPendingConversationReplyForUser(
    telegramUserId: string,
  ): ConversationReply | null {
    assertTelegramUserId(telegramUserId);
    const row = this.#database
      .prepare(`
        SELECT source_update_id, telegram_user_id, chat_id, text,
               reply_markup_json, status, update_processed, created_at, delivered_at
        FROM conversation_replies
        WHERE telegram_user_id = ?
          AND status = 'pending'
        ORDER BY created_at, source_update_id
        LIMIT 1
      `)
      .get(telegramUserId);
    return row === undefined ? null : rowToConversationReply(row);
  }

  markConversationReplyDelivered(sourceUpdateId: number): boolean {
    this.#assertUpdateId(sourceUpdateId);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getConversationReply(sourceUpdateId);
      if (existing === null) {
        this.#database.exec('COMMIT');
        return false;
      }
      if (existing.updateProcessed) {
        this.#database
          .prepare('DELETE FROM conversation_replies WHERE source_update_id = ?')
          .run(sourceUpdateId);
      } else if (existing.status === 'pending') {
        this.#database
          .prepare(`
            UPDATE conversation_replies
            SET status = 'delivered', delivered_at = ?
            WHERE source_update_id = ? AND status = 'pending'
          `)
          .run(this.#clock().toISOString(), sourceUpdateId);
      }
      this.#database.exec('COMMIT');
      return true;
    } catch (error) {
      this.#rollback(error, 'Conversation reply delivery transaction rollback failed');
    }
  }

  deleteConversationReply(sourceUpdateId: number): boolean {
    this.#assertUpdateId(sourceUpdateId);
    const result = this.#database
      .prepare('DELETE FROM conversation_replies WHERE source_update_id = ?')
      .run(sourceUpdateId);
    return result.changes === 1 || result.changes === 1n;
  }

  deleteConversationSession(telegramUserId: string, flowId?: string): boolean {
    assertTelegramUserId(telegramUserId);
    if (flowId !== undefined) assertShortIdentifier(flowId, 'conversation flow ID');
    const result = flowId === undefined
      ? this.#database
          .prepare('DELETE FROM conversation_sessions WHERE telegram_user_id = ?')
          .run(telegramUserId)
      : this.#database
          .prepare(`
            DELETE FROM conversation_sessions
            WHERE telegram_user_id = ? AND flow_id = ?
          `)
          .run(telegramUserId, flowId);
    return result.changes === 1 || result.changes === 1n;
  }

  listBankOutbox(limit = 50): readonly BankOutboxItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Invalid bank outbox limit');
    }
    return this.#database
      .prepare(`
        SELECT id, bank_operation_id, telegram_user_id, chat_id,
               message_kind, payload_json, attempts, next_attempt_at, created_at
        FROM bank_outbox
        ORDER BY created_at, id
        LIMIT ?
      `)
      .all(limit)
      .map(rowToBankOutbox);
  }

  listDueBankOutbox(limit = 50): readonly BankOutboxItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Invalid bank outbox limit');
    }
    const nowMs = this.#dateToMilliseconds(this.#clock());
    return this.#database
      .prepare(`
        SELECT id, bank_operation_id, telegram_user_id, chat_id,
               message_kind, payload_json, attempts, next_attempt_at, created_at
        FROM bank_outbox
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, created_at, id
        LIMIT ?
      `)
      .all(nowMs, limit)
      .map(rowToBankOutbox);
  }

  hasBankOutboxForOperation(
    telegramUserId: string,
    sourceKind: BankOperationSource,
    operationId: string,
  ): boolean {
    assertTelegramUserId(telegramUserId);
    assertBankOperationSource(sourceKind);
    assertOperationId(operationId);
    return this.#database
      .prepare(`
        SELECT 1 AS present
        FROM bank_outbox AS outbox
        INNER JOIN bank_operations AS operation
          ON operation.id = outbox.bank_operation_id
        WHERE operation.telegram_user_id = ?
          AND operation.source_kind = ?
          AND operation.operation_id = ?
        LIMIT 1
      `)
      .get(telegramUserId, sourceKind, operationId) !== undefined;
  }

  deferBankOutbox(id: number, attempts: number, nextAttemptAt: number): boolean {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Invalid bank outbox ID');
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 31) {
      throw new TypeError('Invalid bank outbox attempts');
    }
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) {
      throw new TypeError('Invalid bank outbox retry time');
    }
    const result = this.#database
      .prepare(`
        UPDATE bank_outbox
        SET attempts = ?, next_attempt_at = ?
        WHERE id = ?
          AND (
            attempts < ?
            OR (
              attempts = 31
              AND ? = 31
              AND next_attempt_at < ?
            )
          )
      `)
      .run(attempts, nextAttemptAt, id, attempts, attempts, nextAttemptAt);
    return result.changes === 1 || result.changes === 1n;
  }

  completeBankOutbox(id: number): boolean {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Invalid bank outbox ID');
    const result = this.#database.prepare('DELETE FROM bank_outbox WHERE id = ?').run(id);
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
      this.#database
        .prepare(`
          UPDATE conversation_replies
          SET update_processed = 1
          WHERE source_update_id = ?
        `)
        .run(updateId);
      this.#database
        .prepare(`
          DELETE FROM conversation_replies
          WHERE source_update_id = ? AND status = 'delivered'
        `)
        .run(updateId);
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
      this.#pruneDeliveredConversationReplies(nowMs);
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

  #replayBankOperation(
    telegramUserId: string,
    sourceKind: BankOperationSource,
    operationId: string,
    commandHash: string,
  ): BankOperationResult | null {
    const row = this.#database
      .prepare(`
        SELECT id, command_hash, outcome_json, bank_revision
        FROM bank_operations
        WHERE telegram_user_id = ? AND source_kind = ? AND operation_id = ?
      `)
      .get(telegramUserId, sourceKind, operationId);
    if (row === undefined) return null;
    if (!isRecord(row)) throw new Error('Invalid bank operation row');
    if (expectString(row, 'command_hash') !== commandHash) {
      throw new BankIdempotencyConflictError();
    }
    const id = expectNumber(row, 'id');
    const operationRevision = expectNumber(row, 'bank_revision');
    if (id < 1 || operationRevision < 1) throw new Error('Invalid bank operation identity');
    const outcomeJson = expectString(row, 'outcome_json');
    const state = this.getBankState(telegramUserId);
    if (state === null) throw new Error('Replayed bank operation has no bank state');
    return {
      replayed: true,
      operationId: id,
      operationRevision,
      state,
      outcome: parseStoredJson(outcomeJson, 'bank operation outcome'),
    };
  }

  #insertBankOperation(input: {
    readonly telegramUserId: string;
    readonly sourceKind: BankOperationSource;
    readonly operationId: string;
    readonly commandHash: string;
    readonly operationKind: string;
    readonly outcomeJson: string;
    readonly bankRevision: number;
    readonly createdAt: string;
  }): number {
    const result = this.#database
      .prepare(`
        INSERT INTO bank_operations (
          telegram_user_id, source_kind, operation_id, command_hash,
          operation_kind, outcome_json, bank_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.telegramUserId,
        input.sourceKind,
        input.operationId,
        input.commandHash,
        input.operationKind,
        input.outcomeJson,
        input.bankRevision,
        input.createdAt,
      );
    const id = typeof result.lastInsertRowid === 'bigint'
      ? Number(result.lastInsertRowid)
      : result.lastInsertRowid;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid bank operation row ID');
    return id;
  }

  #makeRoomForFreshUserOperation(
    telegramUserId: string,
    sourceKind: Exclude<BankOperationSource, 'import'>,
  ): void {
    if (sourceKind !== 'telegram' && sourceKind !== 'tma') return;
    const countRow = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM bank_operations
        WHERE telegram_user_id = ?
          AND source_kind IN ('telegram', 'tma')
      `)
      .get(telegramUserId);
    if (!isRecord(countRow)) throw new Error('Invalid bank operation count');
    const count = expectNumber(countRow, 'count');
    if (count < this.#maxBankOperationsPerUser) return;

    const requiredSlots = count - this.#maxBankOperationsPerUser + 1;
    const candidates = this.#database
      .prepare(`
        SELECT operation.id
        FROM bank_operations AS operation
        WHERE operation.telegram_user_id = ?
          AND operation.source_kind IN ('telegram', 'tma')
          AND NOT EXISTS (
            SELECT 1
            FROM bank_outbox AS outbox
            WHERE outbox.bank_operation_id = operation.id
        )
        ORDER BY operation.id ASC
        LIMIT ?
      `)
      .all(telegramUserId, requiredSlots);
    if (candidates.length !== requiredSlots) throw new BankOperationCapacityError();
    const deleteCandidate = this.#database.prepare(`
      DELETE FROM bank_operations
      WHERE id = ?
        AND telegram_user_id = ?
        AND source_kind IN ('telegram', 'tma')
        AND NOT EXISTS (
          SELECT 1
          FROM bank_outbox AS outbox
          WHERE outbox.bank_operation_id = bank_operations.id
        )
    `);
    for (const candidate of candidates) {
      if (!isRecord(candidate)) throw new Error('Invalid bank operation retention candidate');
      const candidateId = expectNumber(candidate, 'id');
      if (candidateId < 1) throw new Error('Invalid bank operation retention candidate');
      const deleted = deleteCandidate.run(candidateId, telegramUserId);
      if (deleted.changes !== 1) throw new BankOperationCapacityError();
    }
  }

  #insertBankOutbox(input: {
    readonly bankOperationId: number;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly messageKind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }): void {
    assertShortIdentifier(input.messageKind, 'bank outbox message kind');
    const payloadJson = normalizeBoundedJson(
      input.payload,
      MAX_BANK_OUTCOME_JSON_BYTES,
      'Bank outbox payload',
    );
    this.#database
      .prepare(`
        INSERT INTO bank_outbox (
          bank_operation_id, telegram_user_id, chat_id,
          message_kind, payload_json, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      `)
      .run(
        input.bankOperationId,
        input.telegramUserId,
        input.chatId,
        input.messageKind,
        payloadJson,
        input.createdAt,
      );
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

  #pruneDeliveredConversationReplies(nowMs: number): void {
    const cutoffMs = Math.max(0, nowMs - UPDATE_SEQUENCE_RESET_AFTER_MS);
    this.#database
      .prepare(`
        DELETE FROM conversation_replies
        WHERE status = 'delivered' AND created_at <= ?
      `)
      .run(new Date(cutoffMs).toISOString());
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
      this.#ensureBankExtensions();
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
    this.#ensureBankExtensions();
  }

  #ensureBankExtensions(): void {
    const serviceStateColumns = new Set(
      this.#database
        .prepare('PRAGMA table_info(service_state)')
        .all()
        .map((row) => isRecord(row) && typeof row.name === 'string' ? row.name : ''),
    );
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (!serviceStateColumns.has('ledger_mode')) {
        this.#database.exec(`
          ALTER TABLE service_state
          ADD COLUMN ledger_mode TEXT NOT NULL DEFAULT 'local'
            CHECK (ledger_mode IN ('local', 'server'));
        `);
      }
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS bank_states (
          telegram_user_id TEXT PRIMARY KEY
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          state_json TEXT NOT NULL
            CHECK (
              length(state_json) BETWEEN 2 AND ${MAX_BANK_STATE_JSON_BYTES}
              AND json_valid(state_json)
              AND json_type(state_json) = 'object'
            ),
          state_digest TEXT NOT NULL
            CHECK (
              length(state_digest) = 64
              AND state_digest NOT GLOB '*[^0-9a-f]*'
            ),
          revision INTEGER NOT NULL
            CHECK (revision BETWEEN 1 AND 9007199254740991),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversation_sessions (
          telegram_user_id TEXT PRIMARY KEY
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          flow_id TEXT NOT NULL CHECK (length(flow_id) BETWEEN 1 AND 64),
          flow_kind TEXT NOT NULL
            CHECK (flow_kind IN ('transaction', 'accounts', 'recurring', 'delete_demo')),
          step TEXT NOT NULL CHECK (length(step) BETWEEN 1 AND 64),
          draft_json TEXT NOT NULL
            CHECK (
              length(draft_json) BETWEEN 2 AND ${MAX_CONVERSATION_DRAFT_JSON_BYTES}
              AND json_valid(draft_json)
            ),
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversation_replies (
          source_update_id INTEGER PRIMARY KEY
            CHECK (source_update_id BETWEEN 0 AND 9007199254740991),
          telegram_user_id TEXT NOT NULL
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL
            CHECK (
              length(chat_id) > 0
              AND substr(chat_id, 1, 1) != '0'
              AND chat_id NOT GLOB '*[^0-9]*'
            ),
          text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
          reply_markup_json TEXT
            CHECK (
              reply_markup_json IS NULL
              OR (
                length(reply_markup_json) BETWEEN 2 AND ${MAX_CONVERSATION_REPLY_MARKUP_JSON_BYTES}
                AND json_valid(reply_markup_json)
                AND json_type(reply_markup_json) = 'object'
              )
          ),
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
          update_processed INTEGER NOT NULL DEFAULT 0
            CHECK (update_processed IN (0, 1)),
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          CHECK (
            (status = 'pending' AND delivered_at IS NULL)
            OR (status = 'delivered' AND delivered_at IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX IF NOT EXISTS conversation_replies_pending_user_idx
          ON conversation_replies (telegram_user_id, status, created_at, source_update_id);

        CREATE UNIQUE INDEX IF NOT EXISTS conversation_replies_one_pending_user_idx
          ON conversation_replies (telegram_user_id)
          WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS bank_operations (
          id INTEGER PRIMARY KEY,
          telegram_user_id TEXT NOT NULL
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          source_kind TEXT NOT NULL
            CHECK (source_kind IN ('import', 'telegram', 'tma', 'system')),
          operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 96),
          command_hash TEXT NOT NULL
            CHECK (
              length(command_hash) = 64
              AND command_hash NOT GLOB '*[^0-9a-f]*'
            ),
          operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 64),
          outcome_json TEXT NOT NULL
            CHECK (
              length(outcome_json) BETWEEN 2 AND ${MAX_BANK_OUTCOME_JSON_BYTES}
              AND json_valid(outcome_json)
            ),
          bank_revision INTEGER NOT NULL
            CHECK (bank_revision BETWEEN 1 AND 9007199254740991),
          created_at TEXT NOT NULL,
          UNIQUE (telegram_user_id, source_kind, operation_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS bank_outbox (
          id INTEGER PRIMARY KEY,
          bank_operation_id INTEGER NOT NULL UNIQUE
            REFERENCES bank_operations (id) ON DELETE CASCADE,
          telegram_user_id TEXT NOT NULL
            REFERENCES users (telegram_user_id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL
            CHECK (
              length(chat_id) > 0
              AND substr(chat_id, 1, 1) != '0'
              AND chat_id NOT GLOB '*[^0-9]*'
            ),
          message_kind TEXT NOT NULL CHECK (length(message_kind) BETWEEN 1 AND 64),
          payload_json TEXT NOT NULL
            CHECK (
              length(payload_json) BETWEEN 2 AND ${MAX_BANK_OUTCOME_JSON_BYTES}
              AND json_valid(payload_json)
            ),
          attempts INTEGER NOT NULL DEFAULT 0
            CHECK (attempts BETWEEN 0 AND 31),
          next_attempt_at INTEGER NOT NULL DEFAULT 0
            CHECK (next_attempt_at BETWEEN 0 AND 9007199254740991),
          created_at TEXT NOT NULL
        ) STRICT;
      `);
      const conversationReplyColumns = new Set(
        this.#database
          .prepare('PRAGMA table_info(conversation_replies)')
          .all()
          .map((row) => isRecord(row) && typeof row.name === 'string' ? row.name : ''),
      );
      if (!conversationReplyColumns.has('update_processed')) {
        this.#database.exec(`
          ALTER TABLE conversation_replies
          ADD COLUMN update_processed INTEGER NOT NULL DEFAULT 0
            CHECK (update_processed IN (0, 1));
        `);
      }
      const bankOutboxColumns = new Set(
        this.#database
          .prepare('PRAGMA table_info(bank_outbox)')
          .all()
          .map((row) => isRecord(row) && typeof row.name === 'string' ? row.name : ''),
      );
      if (!bankOutboxColumns.has('attempts')) {
        this.#database.exec(`
          ALTER TABLE bank_outbox
          ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
            CHECK (attempts BETWEEN 0 AND 31);
        `);
      }
      if (!bankOutboxColumns.has('next_attempt_at')) {
        this.#database.exec(`
          ALTER TABLE bank_outbox
          ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0
            CHECK (next_attempt_at BETWEEN 0 AND 9007199254740991);
        `);
      }
      this.ledgerMode();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#rollback(error, 'Bank SQLite extension rollback failed');
    }
  }

}
