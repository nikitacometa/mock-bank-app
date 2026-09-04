import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotHttpServer, type ReadinessSnapshot } from './http-server.js';
import type { LogContext, ServiceLogger } from './logger.js';
import { PreferencesRepository } from './repository.js';

const TOKEN = ['123456', 'synthetic_token_that_is_long_enough_for_tests'].join(':');
const NOW = 1_700_000_000;
const PUBLIC_URL = new URL('https://euphoria.bot/');

function signedInitData(authDate = NOW): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'query-1',
    user: JSON.stringify({
      id: 42,
      first_name: 'Ada',
      last_name: 'Lovelace',
      language_code: 'en',
    }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.append('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('bot HTTP service', () => {
  let repository: PreferencesRepository;
  let readiness: ReadinessSnapshot;
  let server: ReturnType<typeof createBotHttpServer>;
  let baseUrl: string;
  let errorLogs: Array<{ readonly event: string; readonly context?: LogContext }>;

  beforeEach(async () => {
    repository = new PreferencesRepository(':memory:');
    readiness = { botSetup: true, polling: true, shuttingDown: false };
    errorLogs = [];
    const logger: ServiceLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (event, context) => errorLogs.push({ event, context }),
    };
    server = createBotHttpServer({
      repository,
      botToken: TOKEN,
      publicWebAppUrl: PUBLIC_URL,
      readiness: () => readiness,
      nowSeconds: () => NOW,
      logger,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    repository.close();
  });

  it('returns the strict bootstrap contract from validated initData', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: PUBLIC_URL.origin,
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL.origin);
    expect(await response.json()).toEqual({
      version: 1,
      revisionEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
      revision: 1,
      locale: 'en',
      primaryCurrency: 'KZT',
      displayName: 'Ada Lovelace',
      telegramId: '42',
      onboardingComplete: false,
    });
  });

  it('rejects a wrong origin without reflecting it', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `tma ${signedInitData()}`,
        'content-type': 'application/json',
        origin: 'https://attacker.invalid',
      },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
    expect(errorLogs).toEqual([]);
  });

  it('requires JSON, an empty object body, and a bounded payload', async () => {
    const authorization = `tma ${signedInitData()}`;
    const wrongType = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'text/plain', origin: PUBLIC_URL.origin },
      body: '{}',
    });
    const wrongShape = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', origin: PUBLIC_URL.origin },
      body: '{"unexpected":true}',
    });
    const oversized = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', origin: PUBLIC_URL.origin },
      body: JSON.stringify({ padding: 'x'.repeat(1_100) }),
    });

    expect(wrongType.status).toBe(415);
    expect(wrongShape.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it('maps missing, invalid, and stale authorization to one non-oracular response', async () => {
    const headers = { 'content-type': 'application/json', origin: PUBLIC_URL.origin };
    const missing = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const invalid = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { ...headers, authorization: `tma ${signedInitData()}x` },
      body: '{}',
    });
    const stale = await fetch(`${baseUrl}/bootstrap`, {
      method: 'POST',
      headers: { ...headers, authorization: `tma ${signedInitData(NOW - 86_401)}` },
      body: '{}',
    });

    for (const response of [missing, invalid, stale]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_init_data' });
    }
  });

  it('reports readiness without exposing configuration or secrets', async () => {
    readiness = { botSetup: false, polling: false, shuttingDown: false };
    const starting = await fetch(`${baseUrl}/healthz`);
    const startingBody = await starting.text();
    expect(starting.status).toBe(503);
    expect(startingBody).not.toContain(TOKEN);
    expect(startingBody).not.toContain('euphoria.bot');

    readiness = { botSetup: true, polling: true, shuttingDown: false };
    const ready = await fetch(`${baseUrl}/healthz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', ready: true });
  });

  it('answers same-origin CORS preflight with the narrow method and headers', async () => {
    const response = await fetch(`${baseUrl}/bootstrap`, {
      method: 'OPTIONS',
      headers: { origin: PUBLIC_URL.origin },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL.origin);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST');
    expect(response.headers.get('access-control-allow-headers'))
      .toBe('authorization, content-type');
  });

  it('logs only safe metadata for an unexpected bootstrap failure', async () => {
    const authorization = `tma ${signedInitData()}`;
    const privateErrorText = `repository failure containing ${TOKEN}`;
    const ensureUser = repository.ensureUser.bind(repository);
    repository.ensureUser = () => {
      const error = new Error(privateErrorText);
      error.name = authorization;
      throw error;
    };
    try {
      const response = await fetch(`${baseUrl}/bootstrap`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          origin: PUBLIC_URL.origin,
        },
        body: '{}',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal_error' });
      expect(errorLogs).toEqual([{
        event: 'bot_http_request_failed',
        context: {
          method: 'POST',
          route: '/bootstrap',
          errorType: 'Error',
        },
      }]);
      const serializedLogs = JSON.stringify(errorLogs);
      expect(serializedLogs).not.toContain(authorization);
      expect(serializedLogs).not.toContain(TOKEN);
      expect(serializedLogs).not.toContain(privateErrorText);
    } finally {
      repository.ensureUser = ensureUser;
    }
  });
});
