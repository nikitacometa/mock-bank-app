import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const TOKEN = ['123456', 'synthetic_token_that_is_long_enough_for_tests'].join(':');

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BOT_TOKEN: TOKEN,
    PUBLIC_WEB_APP_URL: 'https://euphoria.bot/',
    DATA_PATH: '/data/cometa-bank.sqlite',
    PORT: '8787',
  };
}

describe('loadConfig', () => {
  it('loads the strict inline development configuration', () => {
    const config = loadConfig(baseEnv());

    expect(config).toEqual({
      botToken: TOKEN,
      publicWebAppUrl: new URL('https://euphoria.bot/'),
      dataPath: '/data/cometa-bank.sqlite',
      port: 8787,
    });
  });

  it('loads a raw token from a service-owned 0600 file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-secret-'));
    const tokenPath = join(directory, 'bot_token');
    try {
      await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
      const env = baseEnv();
      delete env.BOT_TOKEN;
      env.BOT_TOKEN_FILE = tokenPath;

      expect(loadConfig(env).botToken).toBe(TOKEN);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous token sources and does not echo a token fragment', () => {
    const both = { ...baseEnv(), BOT_TOKEN_FILE: '/run/secrets/bot_token' };
    expect(() => loadConfig(both)).toThrow('Set exactly one');

    const invalid = { ...baseEnv(), BOT_TOKEN: 'secret-fragment-that-must-not-leak' };
    try {
      loadConfig(invalid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('secret-fragment');
      return;
    }
    throw new Error('Expected invalid token configuration');
  });

  it('rejects inline tokens in production', () => {
    expect(() => loadConfig({ ...baseEnv(), NODE_ENV: 'production' }))
      .toThrow('BOT_TOKEN is disabled in production');
  });

  it('rejects group/world-readable token files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cometa-bot-secret-mode-'));
    const tokenPath = join(directory, 'bot_token');
    try {
      await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o644);
      const env = baseEnv();
      delete env.BOT_TOKEN;
      env.BOT_TOKEN_FILE = tokenPath;

      expect(() => loadConfig(env)).toThrow('permissions must be 0600 or stricter');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe URLs, relative data paths, and out-of-range ports', () => {
    expect(() => loadConfig({ ...baseEnv(), PUBLIC_WEB_APP_URL: 'http://euphoria.bot/' }))
      .toThrow('credential-free HTTPS URL');
    expect(() => loadConfig({ ...baseEnv(), PUBLIC_WEB_APP_URL: 'https://euphoria.bot/?x=1' }))
      .toThrow('credential-free HTTPS URL');
    expect(() => loadConfig({ ...baseEnv(), DATA_PATH: 'bot.sqlite' }))
      .toThrow('absolute filesystem path');
    expect(() => loadConfig({ ...baseEnv(), PORT: '65536' }))
      .toThrow('between 1 and 65535');
  });
});
