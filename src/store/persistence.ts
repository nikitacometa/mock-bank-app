import type { BankState } from '@/domain/types';

/**
 * The ONLY file that touches localStorage (enforced by eslint.config.js).
 * Backing store swaps (Telegram CloudStorage, backend) happen here alone.
 */
const KEY = 'cometa.bank';
export const SCHEMA_VERSION = 1;

interface Envelope {
  schemaVersion: number;
  state: BankState;
}

/** Minimal shape validation — not a full schema, just enough to refuse junk. */
function looksLikeBankState(s: unknown): s is BankState {
  if (typeof s !== 'object' || s === null) return false;
  const b = s as BankState;
  return (
    Array.isArray(b.accounts) &&
    Array.isArray(b.transactions) &&
    Array.isArray(b.cards) &&
    Array.isArray(b.contacts) &&
    typeof b.nextSeq === 'number' &&
    b.transactions.every(
      (t) => Number.isSafeInteger(t.amountMinor) && Number.isSafeInteger(t.balanceAfterMinor),
    )
  );
}

export type LoadResult =
  | { kind: 'ok'; state: BankState }
  | { kind: 'empty' }
  | { kind: 'corrupted' };

export function loadPersisted(): LoadResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { kind: 'empty' }; // storage unavailable (private mode) — run in-memory
  }
  if (raw === null) return { kind: 'empty' };
  try {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.schemaVersion !== SCHEMA_VERSION || !looksLikeBankState(envelope.state)) {
      return { kind: 'corrupted' };
    }
    return { kind: 'ok', state: envelope.state };
  } catch {
    return { kind: 'corrupted' };
  }
}

export function savePersisted(state: BankState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }));
  } catch {
    // Quota/private mode: the demo keeps working in-memory; nothing to surface mid-flow.
  }
}

/**
 * Cross-tab sync: another tab wrote — reread instead of silently clobbering
 * each other (the documented two-tabs bug class).
 */
export function onCrossTabChange(cb: (state: BankState) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== KEY || e.newValue === null) return;
    const result = loadPersisted();
    if (result.kind === 'ok') cb(result.state);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
