import { BotApiClient, TelegramApiError, type BotCommand } from './bot-api.js';
import type { ServiceLogger } from './logger.js';

const EN_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Open Cometa' },
  { command: 'settings', description: 'Language, currency, and name' },
  { command: 'help', description: 'How the demo works' },
  { command: 'privacy', description: 'What Cometa stores' },
];

const RU_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Открыть Cometa' },
  { command: 'settings', description: 'Язык, валюта и имя' },
  { command: 'help', description: 'Как работает демо' },
  { command: 'privacy', description: 'Какие данные хранит Cometa' },
];

const SETUP_ATTEMPTS = 5;
const INITIAL_SETUP_BACKOFF_MS = 1_000;
const MAX_SETUP_BACKOFF_MS = 15_000;
const MAX_SETUP_RETRY_AFTER_MS = 120_000;
const SETUP_DEADLINE_MS = 150_000;

type SetupSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

interface SetupRetryOptions {
  readonly sleep?: SetupSleep;
  readonly deadlineSignal?: AbortSignal;
}

interface ProfileSetupAction {
  readonly step: string;
  readonly run: () => Promise<void>;
}

function abortableSetupDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableSetupError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return true;
  const code = error.errorCode ?? error.status;
  return code === 429 || code >= 500;
}

function setupErrorContext(error: unknown): Readonly<Record<string, string | number>> {
  if (error instanceof TelegramApiError) {
    return {
      errorType: error.name,
      status: error.status,
      ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
    };
  }
  return { errorType: error instanceof Error ? error.name : 'unknown' };
}

async function retrySetupStep(
  step: string,
  action: () => Promise<void>,
  signal: AbortSignal,
  logger: ServiceLogger,
  sleep: SetupSleep,
): Promise<void> {
  for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    try {
      await action();
      return;
    } catch (error: unknown) {
      if (signal.aborted || !isRetryableSetupError(error) || attempt === SETUP_ATTEMPTS) {
        throw error;
      }
      const exponential = Math.min(
        MAX_SETUP_BACKOFF_MS,
        INITIAL_SETUP_BACKOFF_MS * 2 ** (attempt - 1),
      );
      const retryAfter = error instanceof TelegramApiError
        ? Math.min((error.retryAfter ?? 0) * 1_000, MAX_SETUP_RETRY_AFTER_MS)
        : 0;
      const retryMs = Math.max(exponential, retryAfter);
      logger.warn('telegram_setup_retry', {
        step,
        attempt,
        retryMs,
        ...setupErrorContext(error),
      });
      await sleep(retryMs, signal);
    }
  }
}

export async function reconcileWebhook(
  client: BotApiClient,
  signal: AbortSignal,
): Promise<void> {
  const before = await client.getWebhookInfo(signal);
  if (before.url === '') return;
  await client.deleteWebhook(signal);
  const after = await client.getWebhookInfo(signal);
  if (after.url !== '') throw new Error('Telegram webhook is still active');
}

export async function setupBotProfile(
  client: BotApiClient,
  signal: AbortSignal,
): Promise<void> {
  for (const action of profileSetupActions(client, signal)) await action.run();
}

function profileSetupActions(
  client: BotApiClient,
  signal: AbortSignal,
): readonly ProfileSetupAction[] {
  return [
    { step: 'profile.identity', run: () => client.getMe(signal) },
    { step: 'profile.menu.default', run: () => client.setDefaultMenuButton(signal) },
    {
      step: 'profile.commands.default',
      run: () => client.setMyCommands(EN_COMMANDS, undefined, signal),
    },
    { step: 'profile.commands.ru', run: () => client.setMyCommands(RU_COMMANDS, 'ru', signal) },
    { step: 'profile.commands.en', run: () => client.setMyCommands(EN_COMMANDS, 'en', signal) },
    { step: 'profile.name.default', run: () => client.setMyName('Cometa', undefined, signal) },
    { step: 'profile.name.ru', run: () => client.setMyName('Cometa', 'ru', signal) },
    { step: 'profile.name.en', run: () => client.setMyName('Cometa', 'en', signal) },
    {
      step: 'profile.description.default',
      run: () => client.setMyDescription(
        'A polished personal demo bank with multi-currency accounts. No real money or payments.',
        undefined,
        signal,
      ),
    },
    {
      step: 'profile.description.ru',
      run: () => client.setMyDescription(
        'Личный мультивалютный демо-банк. Без реальных денег и платежей.',
        'ru',
        signal,
      ),
    },
    {
      step: 'profile.description.en',
      run: () => client.setMyDescription(
        'A polished personal demo bank with multi-currency accounts. No real money or payments.',
        'en',
        signal,
      ),
    },
    {
      step: 'profile.short-description.default',
      run: () => client.setMyShortDescription(
        'Personal multi-currency demo bank',
        undefined,
        signal,
      ),
    },
    {
      step: 'profile.short-description.ru',
      run: () => client.setMyShortDescription(
        'Личный мультивалютный демо-банк',
        'ru',
        signal,
      ),
    },
    {
      step: 'profile.short-description.en',
      run: () => client.setMyShortDescription(
        'Personal multi-currency demo bank',
        'en',
        signal,
      ),
    },
  ];
}

export async function setupBotForPolling(
  client: BotApiClient,
  signal: AbortSignal,
  logger: ServiceLogger,
  options: SetupRetryOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? abortableSetupDelay;
  const deadlineSignal = options.deadlineSignal ?? AbortSignal.timeout(SETUP_DEADLINE_MS);
  const setupSignal = AbortSignal.any([signal, deadlineSignal]);
  try {
    await retrySetupStep(
      'webhook',
      () => reconcileWebhook(client, setupSignal),
      setupSignal,
      logger,
      sleep,
    );
    for (const action of profileSetupActions(client, setupSignal)) {
      await retrySetupStep(action.step, action.run, setupSignal, logger, sleep);
    }
  } catch (error: unknown) {
    if (deadlineSignal.aborted && !signal.aborted) {
      throw new Error('Telegram bot startup setup deadline exceeded', { cause: error });
    }
    throw error;
  }
}
