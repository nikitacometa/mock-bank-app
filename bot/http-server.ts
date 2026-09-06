import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BankServiceError,
  type BankCommandResponse,
  type BankImportResponse,
  type BankRatesRefreshResponse,
  type BootstrapBankPayload,
  type CanonicalBankPreferences,
} from './bank-service.js';
import { canonicalJsonDigest } from './canonical-json.js';
import { telegramDisplayName } from './html.js';
import { InitDataError, parseTmaAuthorization, validateTelegramInitData } from './init-data.js';
import { serviceLogger, type ServiceLogger } from './logger.js';
import { preferredLocale } from './model.js';
import {
  InMemoryBankRequestLimiter,
  type BankRateLimitKind,
  type BankRequestLimiter,
} from './rate-limit.js';
import { PreferencesRepository } from './repository.js';

const MAX_BOOTSTRAP_BODY_BYTES = 1024;
const MAX_BANK_COMMAND_BODY_BYTES = 64 * 1024;
const MAX_BANK_IMPORT_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MAX_BANK_RATES_BODY_BYTES = 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface ReadinessSnapshot {
  readonly botSetup: boolean;
  readonly polling: boolean;
  readonly shuttingDown: boolean;
}

export interface HttpServerOptions {
  readonly repository: PreferencesRepository;
  readonly botToken: string;
  readonly publicWebAppUrl: URL;
  readonly readiness: () => ReadinessSnapshot;
  readonly nowSeconds?: () => number;
  readonly logger?: ServiceLogger;
  readonly bankService?: BankHttpService;
  readonly bankRequestLimiter?: BankRequestLimiter;
}

export interface BankHttpService {
  readonly bootstrap: (telegramUserId: string) => BootstrapBankPayload | null;
  readonly importState: (input: {
    readonly telegramUserId: string;
    readonly importId: string;
    readonly stateVersion: 4 | 5;
    readonly rawState: unknown;
  }) => BankImportResponse;
  readonly executeCommand: (input: {
    readonly telegramUserId: string;
    readonly sourceKind: 'tma';
    readonly operationId: string;
    readonly rawCommand: unknown;
  }) => BankCommandResponse;
  readonly refreshRates: (telegramUserId: string) => Promise<BankRatesRefreshResponse>;
  readonly preferencesForBank: (payload: Extract<BootstrapBankPayload, { mode: 'server' }>) =>
    CanonicalBankPreferences;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

function safeRequestMethod(method: string | undefined): string {
  return method !== undefined && SAFE_METHODS.has(method) ? method : 'OTHER';
}

function safeRequestRoute(requestUrl: string | undefined): string {
  let pathname: string;
  try {
    pathname = new URL(requestUrl ?? '/', 'http://service.invalid').pathname;
  } catch {
    return 'unknown';
  }
  if (pathname === '/bootstrap') return '/bootstrap';
  if (pathname === '/bank-import') return '/bank-import';
  if (pathname === '/bank-command') return '/bank-command';
  if (pathname === '/bank-rates') return '/bank-rates';
  if (pathname === '/healthz') return '/healthz';
  return 'unknown';
}

function safeErrorType(error: unknown): string {
  if (error instanceof AggregateError) return 'AggregateError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof ReferenceError) return 'ReferenceError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof Error) return 'Error';
  return 'unknown';
}

function setBaseHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-content-type-options', 'nosniff');
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: object,
): void {
  setBaseHeaders(response);
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

function enforceOrigin(request: IncomingMessage, response: ServerResponse, expectedOrigin: string): void {
  response.setHeader('vary', 'Origin');
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (origin !== expectedOrigin) throw new HttpError(403, 'origin_not_allowed');
  response.setHeader('access-control-allow-origin', expectedOrigin);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new HttpError(415, 'content_type_required');
  }
  const rawLength = request.headers['content-length'];
  if (rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength) || Number(rawLength) > maximumBytes) {
      throw new HttpError(413, 'body_too_large');
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new HttpError(413, 'body_too_large');
    chunks.push(buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body');
  }
  return body as Record<string, unknown>;
}

function hasExactKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateRequestIdentity(
  request: IncomingMessage,
  options: HttpServerOptions,
): ReturnType<typeof validateTelegramInitData> {
  try {
    const rawInitData = parseTmaAuthorization(request.headers.authorization);
    return validateTelegramInitData(rawInitData, options.botToken, {
      nowSeconds: options.nowSeconds?.(),
    });
  } catch (error) {
    if (error instanceof InitDataError) throw new HttpError(401, 'invalid_init_data');
    throw error;
  }
}

function ensureRequestUser(
  validated: ReturnType<typeof validateTelegramInitData>,
  options: HttpServerOptions,
) {
  const locale = preferredLocale(validated.user.languageCode);
  return options.repository.ensureUser({
    telegramUserId: validated.user.id,
    locale,
    primaryCurrency: 'KZT',
    displayName: telegramDisplayName(
      validated.user.firstName,
      validated.user.lastName,
      locale === 'ru' ? 'Друг' : 'Friend',
    ),
  });
}

function enforceBankRateLimit(
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
  telegramUserId: string,
  kind: BankRateLimitKind,
  operationId: string,
  durableReplay: boolean,
  replayFingerprint?: string,
): void {
  const nowMs = options.nowSeconds === undefined
    ? Date.now()
    : options.nowSeconds() * 1_000;
  const retryAfterSeconds = limiter.consume({
    telegramUserId,
    kind,
    sourceKind: 'tma',
    operationId,
    ...(replayFingerprint === undefined ? {} : { replayFingerprint }),
    durableReplay,
    nowMs,
  });
  if (retryAfterSeconds !== null) {
    throw new BankServiceError(429, 'rate_limited', { retryAfterSeconds });
  }
}

function bankReplayFingerprint(value: unknown): string {
  try {
    return canonicalJsonDigest(value);
  } catch {
    throw new HttpError(400, 'invalid_body');
  }
}

async function handleBootstrap(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
): Promise<void> {
  enforceOrigin(request, response, options.publicWebAppUrl.origin);
  const validated = validateRequestIdentity(request, options);
  const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
  if (!hasExactKeys(body, [])) throw new HttpError(400, 'invalid_body');
  enforceBankRateLimit(
    options,
    limiter,
    validated.user.id,
    'bootstrap',
    'bootstrap',
    false,
  );
  const ensured = ensureRequestUser(validated, options);
  const bank = options.bankService?.bootstrap(validated.user.id) ?? null;
  const canonicalPreferences = bank?.mode === 'server'
    ? options.bankService?.preferencesForBank(bank)
    : undefined;
  sendJson(response, 200, {
    version: 1,
    revisionEpoch: options.repository.revisionEpoch(),
    revision: ensured.user.revision,
    locale: ensured.user.locale,
    primaryCurrency: canonicalPreferences?.primaryCurrency ?? ensured.user.primaryCurrency,
    displayName: canonicalPreferences?.displayName ?? ensured.user.displayName,
    telegramId: validated.user.id,
    onboardingComplete: ensured.user.stage === 'complete',
    ...(bank === null ? {} : { bank }),
  });
}

async function handleBankImport(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
): Promise<void> {
  enforceOrigin(request, response, options.publicWebAppUrl.origin);
  const validated = validateRequestIdentity(request, options);
  enforceBankRateLimit(
    options,
    limiter,
    validated.user.id,
    'import_ingress',
    'import_ingress',
    false,
  );
  const body = await readJsonBody(request, MAX_BANK_IMPORT_BODY_BYTES);
  if (
    !hasExactKeys(body, ['version', 'importId', 'stateVersion', 'state']) ||
    body.version !== 1 ||
    typeof body.importId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(body.importId) ||
    (body.stateVersion !== 4 && body.stateVersion !== 5)
  ) {
    throw new HttpError(400, 'invalid_body');
  }
  const operationExists = options.repository.hasBankOperation(
    validated.user.id,
    'import',
    body.importId,
  );
  if (!operationExists) {
    enforceBankRateLimit(
      options,
      limiter,
      validated.user.id,
      'import',
      body.importId,
      false,
    );
  }
  const replayFingerprint = bankReplayFingerprint({
    version: 1,
    stateVersion: body.stateVersion,
    state: body.state,
  });
  if (operationExists) {
    enforceBankRateLimit(
      options,
      limiter,
      validated.user.id,
      'import',
      body.importId,
      options.repository.isExactBankOperation(
        validated.user.id,
        'import',
        body.importId,
        replayFingerprint,
      ),
      replayFingerprint,
    );
  }
  ensureRequestUser(validated, options);
  if (options.bankService === undefined) {
    throw new BankServiceError(503, 'bank_authority_disabled');
  }
  const result = options.bankService.importState({
    telegramUserId: validated.user.id,
    importId: body.importId,
    stateVersion: body.stateVersion,
    rawState: body.state,
  });
  sendJson(response, 200, result);
}

async function handleBankCommand(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
): Promise<void> {
  enforceOrigin(request, response, options.publicWebAppUrl.origin);
  const validated = validateRequestIdentity(request, options);
  enforceBankRateLimit(
    options,
    limiter,
    validated.user.id,
    'command_ingress',
    'command_ingress',
    false,
  );
  const body = await readJsonBody(request, MAX_BANK_COMMAND_BODY_BYTES);
  if (
    !hasExactKeys(body, ['version', 'clientMutationId', 'command']) ||
    body.version !== 1 ||
    typeof body.clientMutationId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(body.clientMutationId)
  ) {
    throw new HttpError(400, 'invalid_body');
  }
  const replayFingerprint = bankReplayFingerprint({ version: 1, command: body.command });
  enforceBankRateLimit(
    options,
    limiter,
    validated.user.id,
    'command',
    body.clientMutationId,
    options.repository.isExactBankOperation(
      validated.user.id,
      'tma',
      body.clientMutationId,
      replayFingerprint,
    ),
    replayFingerprint,
  );
  ensureRequestUser(validated, options);
  if (options.bankService === undefined) {
    throw new BankServiceError(503, 'bank_authority_disabled');
  }
  const result = options.bankService.executeCommand({
    telegramUserId: validated.user.id,
    sourceKind: 'tma',
    operationId: body.clientMutationId,
    rawCommand: body.command,
  });
  sendJson(response, 200, result);
}

async function handleBankRates(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
): Promise<void> {
  enforceOrigin(request, response, options.publicWebAppUrl.origin);
  const validated = validateRequestIdentity(request, options);
  const body = await readJsonBody(request, MAX_BANK_RATES_BODY_BYTES);
  if (
    !hasExactKeys(body, ['version', 'clientMutationId']) ||
    body.version !== 1 ||
    typeof body.clientMutationId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(body.clientMutationId)
  ) {
    throw new HttpError(400, 'invalid_body');
  }
  enforceBankRateLimit(
    options,
    limiter,
    validated.user.id,
    'rates',
    body.clientMutationId,
    false,
  );
  ensureRequestUser(validated, options);
  if (options.bankService === undefined) {
    throw new BankServiceError(503, 'bank_authority_disabled');
  }
  sendJson(response, 200, await options.bankService.refreshRates(validated.user.id));
}

function handleHealth(response: ServerResponse, options: HttpServerOptions): void {
  const readiness = options.readiness();
  const database = options.repository.ping();
  const ready = database && readiness.botSetup && readiness.polling && !readiness.shuttingDown;
  sendJson(response, ready ? 200 : 503, {
    status: ready ? 'ok' : 'starting',
    ready,
    checks: {
      database,
      botSetup: readiness.botSetup,
      polling: readiness.polling,
      shuttingDown: readiness.shuttingDown,
    },
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  limiter: BankRequestLimiter,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://service.invalid');
  if (url.search !== '') throw new HttpError(400, 'query_not_allowed');

  if (url.pathname === '/healthz') {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      throw new HttpError(405, 'method_not_allowed');
    }
    handleHealth(response, options);
    return;
  }

  const bankRoute =
    url.pathname === '/bank-import' ||
    url.pathname === '/bank-command' ||
    url.pathname === '/bank-rates';
  if ((url.pathname === '/bootstrap' || bankRoute) && request.method === 'OPTIONS') {
    enforceOrigin(request, response, options.publicWebAppUrl.origin);
    response.setHeader('access-control-allow-methods', 'POST');
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-max-age', '600');
    setBaseHeaders(response);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (url.pathname === '/bootstrap') {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, OPTIONS');
      throw new HttpError(405, 'method_not_allowed');
    }
    await handleBootstrap(request, response, options, limiter);
    return;
  }

  if (bankRoute) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, OPTIONS');
      throw new HttpError(405, 'method_not_allowed');
    }
    if (url.pathname === '/bank-import') {
      await handleBankImport(request, response, options, limiter);
    } else if (url.pathname === '/bank-command') {
      await handleBankCommand(request, response, options, limiter);
    } else {
      await handleBankRates(request, response, options, limiter);
    }
    return;
  }

  throw new HttpError(404, 'not_found');
}

export function createBotHttpServer(options: HttpServerOptions): Server {
  const logger = options.logger ?? serviceLogger;
  const bankRequestLimiter = options.bankRequestLimiter ?? new InMemoryBankRequestLimiter();
  return createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void route(request, response, options, bankRequestLimiter).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, error.status, { error: error.code });
        return;
      }
      if (error instanceof BankServiceError) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, error.status, {
          error: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
        return;
      }
      logger.error('bot_http_request_failed', {
        method: safeRequestMethod(request.method),
        route: safeRequestRoute(request.url),
        errorType: safeErrorType(error),
      });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: 'internal_error' });
    });
  });
}
