export type BankRateLimitKind =
  | 'bootstrap'
  | 'import_ingress'
  | 'command_ingress'
  | 'import'
  | 'command'
  | 'rates';
export type BankRateLimitSourceKind = 'tma' | 'telegram';

export interface BankRateLimitRequest {
  readonly telegramUserId: string;
  readonly kind: BankRateLimitKind;
  readonly sourceKind: BankRateLimitSourceKind;
  readonly operationId: string;
  /** Canonical command/import digest. Ingress and read-only requests omit it. */
  readonly replayFingerprint?: string;
  /** True only after the exact operation and fingerprint are found in SQLite. */
  readonly durableReplay: boolean;
  readonly nowMs: number;
}

export interface BankRequestLimiter {
  /**
   * Returns a retry delay when rejected. Exact durable mutation replays remain
   * admissible to the mutation budget; bootstrap, import/command ingress, and
   * rate refreshes are charged on every request.
   */
  consume(request: BankRateLimitRequest): number | null;
}

interface RateLimitPolicy {
  readonly maximum: number;
  readonly windowMs: number;
}

interface RateLimitEntry {
  windowStartedAtMs: number;
  count: number;
}

interface RateLimitUserEntries {
  readonly byKind: Map<BankRateLimitKind, RateLimitEntry>;
}

const DEFAULT_POLICIES: Readonly<Record<BankRateLimitKind, RateLimitPolicy>> = {
  bootstrap: { maximum: 30, windowMs: 60 * 1_000 },
  import_ingress: { maximum: 12, windowMs: 60 * 1_000 },
  command_ingress: { maximum: 128, windowMs: 60 * 1_000 },
  import: { maximum: 6, windowMs: 10 * 60 * 1_000 },
  command: { maximum: 120, windowMs: 60 * 1_000 },
  rates: { maximum: 12, windowMs: 60 * 1_000 },
};

type ConfigurableRateLimitPolicies = Readonly<
  Record<
    Exclude<BankRateLimitKind, 'bootstrap' | 'import_ingress' | 'command_ingress'>,
    RateLimitPolicy
  > & {
    readonly bootstrap?: RateLimitPolicy;
    readonly import_ingress?: RateLimitPolicy;
    readonly command_ingress?: RateLimitPolicy;
  }
>;

const MAX_TRACKED_USERS = 2_048;
const MAX_REQUESTS_PER_WINDOW = 128;

export class InMemoryBankRequestLimiter implements BankRequestLimiter {
  readonly #users = new Map<string, RateLimitUserEntries>();
  readonly #policies: Readonly<Record<BankRateLimitKind, RateLimitPolicy>>;
  readonly #maximumTrackedUsers: number;

  constructor(
    policies: ConfigurableRateLimitPolicies = DEFAULT_POLICIES,
    maximumTrackedUsers = MAX_TRACKED_USERS,
  ) {
    const resolvedPolicies = { ...DEFAULT_POLICIES, ...policies };
    for (const policy of Object.values(resolvedPolicies)) {
      if (
        !Number.isSafeInteger(policy.maximum) ||
        policy.maximum < 1 ||
        policy.maximum > MAX_REQUESTS_PER_WINDOW ||
        !Number.isSafeInteger(policy.windowMs) ||
        policy.windowMs < 1_000
      ) {
        throw new TypeError('Invalid bank rate-limit policy');
      }
    }
    if (
      !Number.isSafeInteger(maximumTrackedUsers) ||
      maximumTrackedUsers < 1 ||
      maximumTrackedUsers > MAX_TRACKED_USERS
    ) {
      throw new TypeError('Invalid bank rate-limit user capacity');
    }
    this.#policies = resolvedPolicies;
    this.#maximumTrackedUsers = maximumTrackedUsers;
  }

  consume(request: BankRateLimitRequest): number | null {
    if (!/^[1-9]\d{0,19}$/.test(request.telegramUserId)) {
      throw new TypeError('Invalid rate-limit Telegram user ID');
    }
    const kindIsValid = [
      'bootstrap',
      'import_ingress',
      'command_ingress',
      'import',
      'command',
      'rates',
    ].includes(request.kind);
    const fingerprintIsValid = /^[0-9a-f]{64}$/.test(request.replayFingerprint ?? '');
    const operationIsValid = request.sourceKind === 'tma'
      ? /^[0-9a-f]{32}$/.test(request.operationId)
      : /^\d{1,16}$/.test(request.operationId);
    const fixedRequestIsValid = request.kind === 'bootstrap'
      ? request.sourceKind === 'tma' && request.operationId === 'bootstrap'
      : request.kind === 'import_ingress'
        ? request.sourceKind === 'tma' && request.operationId === 'import_ingress'
        : request.kind === 'command_ingress'
          ? request.sourceKind === 'tma' && request.operationId === 'command_ingress'
          : false;
    const mutationFingerprintIsValid = request.kind === 'import'
      ? request.durableReplay
        ? fingerprintIsValid
        : request.replayFingerprint === undefined || fingerprintIsValid
      : fingerprintIsValid;
    if (
      !kindIsValid ||
      (request.sourceKind !== 'tma' && request.sourceKind !== 'telegram') ||
      ((request.kind === 'bootstrap' || request.kind === 'import_ingress' || request.kind === 'command_ingress')
        ? !fixedRequestIsValid
        : !operationIsValid) ||
      (request.kind === 'import' && request.sourceKind !== 'tma') ||
      (request.kind === 'rates' || request.kind === 'bootstrap' || request.kind === 'import_ingress' || request.kind === 'command_ingress'
        ? request.replayFingerprint !== undefined || request.durableReplay
        : !mutationFingerprintIsValid) ||
      typeof request.durableReplay !== 'boolean'
    ) {
      throw new TypeError('Invalid rate-limit operation ID');
    }
    if (!Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
      throw new TypeError('Invalid rate-limit clock');
    }
    const policy = this.#policies[request.kind];
    let userEntries = this.#users.get(request.telegramUserId);
    if (userEntries === undefined) {
      this.#makeRoom();
      userEntries = {
        byKind: new Map(),
      };
      this.#users.set(request.telegramUserId, userEntries);
    }
    let entry = userEntries.byKind.get(request.kind);
    if (entry === undefined) {
      entry = {
        windowStartedAtMs: request.nowMs,
        count: 0,
      };
      userEntries.byKind.set(request.kind, entry);
    }
    if (
      request.nowMs < entry.windowStartedAtMs ||
      request.nowMs - entry.windowStartedAtMs >= policy.windowMs
    ) {
      entry.windowStartedAtMs = request.nowMs;
      entry.count = 0;
    }
    // Map insertion order is the LRU clock. Refresh the whole user rather than
    // one route bucket so capacity continues to mean distinct identities.
    this.#users.delete(request.telegramUserId);
    this.#users.set(request.telegramUserId, userEntries);
    if (request.durableReplay) return null;
    if (entry.count >= policy.maximum) {
      return Math.max(
        1,
        Math.ceil((entry.windowStartedAtMs + policy.windowMs - request.nowMs) / 1_000),
      );
    }
    entry.count += 1;
    return null;
  }

  #makeRoom(): void {
    if (this.#users.size < this.#maximumTrackedUsers) return;
    const oldestUserId = this.#users.keys().next().value;
    if (oldestUserId !== undefined) this.#users.delete(oldestUserId);
  }
}
