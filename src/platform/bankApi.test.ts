import { describe, expect, it } from 'vitest';
import { appendRow } from '@/domain/ledger';
import { buildSeed, CHECKING_ID } from '@/domain/seed';
import type { BankState } from '@/domain/types';
import {
  parseBankCommandResponse,
  parseBankImportResponse,
  parseBankRatesRefreshResponse,
  parseLaunchState,
  TelegramApiResponseError,
} from './bankApi';

const TELEGRAM_ID = '9007199254740993';
const CLIENT_NOW = '2026-09-06T12:00:00.000Z';
const SERVER_TIME = '2026-09-06T12:00:01.000Z';
const REVISION_EPOCH = '0123456789abcdef0123456789abcdef';
const DIGEST = 'a'.repeat(64);

function serverState(): BankState {
  const seeded = {
    ...buildSeed(SERVER_TIME),
    profile: { displayName: 'Ada Lovelace', telegramId: TELEGRAM_ID },
  };
  return appendRow(seeded, {
    accountId: CHECKING_ID,
    amountMinor: 1,
    kind: 'topup',
    counterparty: 'Clock boundary fixture',
    category: 'transfer',
    createdAt: SERVER_TIME,
  });
}

function revision(state: BankState, serverTime: unknown) {
  return {
    contractVersion: 1,
    mode: 'server',
    serverTime,
    telegramId: TELEGRAM_ID,
    revisionEpoch: REVISION_EPOCH,
    revision: 1,
    digest: DIGEST,
    state,
    warnings: [],
  };
}

function launchPayload(state: BankState, serverTime: unknown) {
  return {
    version: 1,
    revisionEpoch: REVISION_EPOCH,
    revision: 1,
    locale: 'en',
    primaryCurrency: 'KZT',
    displayName: 'Ada Lovelace',
    telegramId: TELEGRAM_ID,
    bank: revision(state, serverTime),
  };
}

function endpointParsers(state: BankState): readonly [string, (serverTime: unknown) => unknown][] {
  return [
    ['bootstrap', (serverTime) => parseLaunchState(launchPayload(state, serverTime), CLIENT_NOW)],
    [
      'import',
      (serverTime) => parseBankImportResponse(
        { version: 1, imported: true, ...revision(state, serverTime) },
        TELEGRAM_ID,
        CLIENT_NOW,
      ),
    ],
    [
      'command',
      (serverTime) => parseBankCommandResponse(
        {
          version: 1,
          applied: true,
          replayed: false,
          outcome: { ok: true, applied: true },
          ...revision(state, serverTime),
        },
        TELEGRAM_ID,
        CLIENT_NOW,
      ),
    ],
    [
      'rates',
      (serverTime) => parseBankRatesRefreshResponse(
        { version: 1, updated: true, ...revision(state, serverTime) },
        TELEGRAM_ID,
        CLIENT_NOW,
      ),
    ],
  ];
}

describe('trusted server response time', () => {
  it.each(endpointParsers(serverState()))(
    'accepts a %s state one second ahead of the captured device clock',
    (_endpoint, parse) => {
      expect(() => parse(SERVER_TIME)).not.toThrow();
    },
  );

  it.each(endpointParsers(serverState()))(
    'rejects missing, malformed, and absurdly drifted serverTime on %s',
    (_endpoint, parse) => {
      for (const invalid of [
        undefined,
        '2026-09-06T12:00:01Z',
        '2026-09-08T12:00:01.000Z',
      ]) {
        expect(() => parse(invalid), String(invalid)).toThrow(TelegramApiResponseError);
      }
    },
  );

  it('does not invent a trusted timestamp before bootstrap returns canonical bank state', () => {
    const preferencesOnly = { ...launchPayload(serverState(), SERVER_TIME) };
    delete (preferencesOnly as { bank?: unknown }).bank;

    expect(() => parseLaunchState(preferencesOnly, CLIENT_NOW)).not.toThrow();
  });
});
