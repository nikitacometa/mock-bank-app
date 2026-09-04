import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface BotConfig {
  readonly botToken: string;
  readonly publicWebAppUrl: URL;
  readonly dataPath: string;
  readonly port: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function readTokenFile(path: string): string {
  if (!isAbsolute(path)) throw new Error('BOT_TOKEN_FILE must be an absolute path');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('BOT_TOKEN_FILE could not be opened safely');
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 256) {
      throw new Error('BOT_TOKEN_FILE must be a small regular file');
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('BOT_TOKEN_FILE permissions must be 0600 or stricter');
    }
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new Error('BOT_TOKEN_FILE must be owned by the service user');
    }
    const contents = readFileSync(descriptor, { encoding: 'utf8' });
    return contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  } finally {
    closeSync(descriptor);
  }
}

function loadBotToken(env: NodeJS.ProcessEnv): string {
  const inlineToken = env.BOT_TOKEN?.trim() === '' ? undefined : env.BOT_TOKEN;
  const tokenFile = env.BOT_TOKEN_FILE?.trim() === '' ? undefined : env.BOT_TOKEN_FILE;
  if (env.NODE_ENV === 'production' && inlineToken !== undefined) {
    throw new Error('BOT_TOKEN is disabled in production; use BOT_TOKEN_FILE');
  }
  if ((inlineToken === undefined) === (tokenFile === undefined)) {
    throw new Error('Set exactly one of BOT_TOKEN or BOT_TOKEN_FILE');
  }
  const token = inlineToken ?? readTokenFile(tokenFile as string);
  if (!/^\d{6,20}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('Telegram bot token has an invalid format');
  }
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const botToken = loadBotToken(env);

  const rawWebAppUrl = required(env, 'PUBLIC_WEB_APP_URL');
  let publicWebAppUrl: URL;
  try {
    publicWebAppUrl = new URL(rawWebAppUrl);
  } catch {
    throw new Error('PUBLIC_WEB_APP_URL must be an absolute HTTPS URL');
  }
  if (
    publicWebAppUrl.protocol !== 'https:' ||
    publicWebAppUrl.username !== '' ||
    publicWebAppUrl.password !== '' ||
    publicWebAppUrl.search !== '' ||
    publicWebAppUrl.hash !== ''
  ) {
    throw new Error('PUBLIC_WEB_APP_URL must be a credential-free HTTPS URL without query or hash');
  }

  const dataPath = required(env, 'DATA_PATH');
  if (!isAbsolute(dataPath) || dataPath.includes('\0')) {
    throw new Error('DATA_PATH must be an absolute filesystem path');
  }

  const rawPort = required(env, 'PORT');
  if (!/^\d{1,5}$/.test(rawPort)) throw new Error('PORT must be an integer');
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535');

  return Object.freeze({ botToken, publicWebAppUrl, dataPath, port });
}
