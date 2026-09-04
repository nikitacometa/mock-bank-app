import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { telegramDisplayName } from './html.js';
import { InitDataError, parseTmaAuthorization, validateTelegramInitData } from './init-data.js';
import { serviceLogger, type ServiceLogger } from './logger.js';
import { preferredLocale } from './model.js';
import { PreferencesRepository } from './repository.js';

const MAX_BOOTSTRAP_BODY_BYTES = 1024;
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
  payload: Readonly<Record<string, unknown>>,
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

async function readBootstrapBody(request: IncomingMessage): Promise<void> {
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new HttpError(415, 'content_type_required');
  }
  const rawLength = request.headers['content-length'];
  if (rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength) || Number(rawLength) > MAX_BOOTSTRAP_BODY_BYTES) {
      throw new HttpError(413, 'body_too_large');
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BOOTSTRAP_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    throw new HttpError(400, 'invalid_body');
  }
}

async function handleBootstrap(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
): Promise<void> {
  enforceOrigin(request, response, options.publicWebAppUrl.origin);
  await readBootstrapBody(request);
  let validated;
  try {
    const rawInitData = parseTmaAuthorization(request.headers.authorization);
    validated = validateTelegramInitData(rawInitData, options.botToken, {
      nowSeconds: options.nowSeconds?.(),
    });
  } catch (error) {
    if (error instanceof InitDataError) throw new HttpError(401, 'invalid_init_data');
    throw error;
  }

  const locale = preferredLocale(validated.user.languageCode);
  const ensured = options.repository.ensureUser({
    telegramUserId: validated.user.id,
    locale,
    primaryCurrency: 'KZT',
    displayName: telegramDisplayName(
      validated.user.firstName,
      validated.user.lastName,
      locale === 'ru' ? 'Друг' : 'Friend',
    ),
  });
  sendJson(response, 200, {
    version: 1,
    revisionEpoch: options.repository.revisionEpoch(),
    revision: ensured.user.revision,
    locale: ensured.user.locale,
    primaryCurrency: ensured.user.primaryCurrency,
    displayName: ensured.user.displayName,
    telegramId: validated.user.id,
    onboardingComplete: ensured.user.stage === 'complete',
  });
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

  if (url.pathname === '/bootstrap' && request.method === 'OPTIONS') {
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
    await handleBootstrap(request, response, options);
    return;
  }

  throw new HttpError(404, 'not_found');
}

export function createBotHttpServer(options: HttpServerOptions): Server {
  const logger = options.logger ?? serviceLogger;
  return createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void route(request, response, options).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, error.status, { error: error.code });
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
