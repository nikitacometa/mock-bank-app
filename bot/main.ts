import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import { BotApiClient } from './bot-api.js';
import { loadConfig } from './config.js';
import { createBotHttpServer, type ReadinessSnapshot } from './http-server.js';
import { serviceLogger } from './logger.js';
import { OnboardingEngine } from './onboarding.js';
import { LongPoller } from './poller.js';
import { PreferencesRepository } from './repository.js';
import { setupBotForPolling } from './setup.js';

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await mkdir(dirname(config.dataPath), { recursive: true, mode: 0o700 });
  const repository = new PreferencesRepository(config.dataPath);
  const client = new BotApiClient(config.botToken, config.publicWebAppUrl);
  const engine = new OnboardingEngine(repository, client, config.publicWebAppUrl, serviceLogger);
  const poller = new LongPoller(client, engine, repository, serviceLogger);
  const readiness: {
    botSetup: boolean;
    polling: boolean;
    shuttingDown: boolean;
  } = { botSetup: false, polling: false, shuttingDown: false };
  const readinessSnapshot = (): ReadinessSnapshot => {
    const pollerHealth = poller.health();
    return {
      ...readiness,
      polling: readiness.polling && pollerHealth.healthy,
    };
  };
  const server = createBotHttpServer({
    repository,
    botToken: config.botToken,
    publicWebAppUrl: config.publicWebAppUrl,
    readiness: readinessSnapshot,
    logger: serviceLogger,
  });
  const abortController = new AbortController();
  const beginShutdown = (): void => {
    if (readiness.shuttingDown) return;
    readiness.shuttingDown = true;
    abortController.abort();
    server.closeIdleConnections();
  };
  process.once('SIGTERM', beginShutdown);
  process.once('SIGINT', beginShutdown);

  let listening = false;
  try {
    await listen(server, config.port);
    listening = true;
    serviceLogger.info('bot_http_listening', { port: config.port });
    await setupBotForPolling(client, abortController.signal, serviceLogger);
    readiness.botSetup = true;
    readiness.polling = true;
    serviceLogger.info('bot_polling_ready');
    await poller.run(abortController.signal);
  } finally {
    readiness.polling = false;
    readiness.shuttingDown = true;
    abortController.abort();
    process.off('SIGTERM', beginShutdown);
    process.off('SIGINT', beginShutdown);
    if (listening) await close(server);
    repository.close();
  }
}

void main().catch((error: unknown) => {
  serviceLogger.error('bot_service_failed', {
    errorType: error instanceof Error ? error.name : 'unknown',
  });
  process.exitCode = 1;
});
