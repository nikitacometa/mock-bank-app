/**
 * Generate an idempotency key without `crypto.randomUUID()`: unlike
 * `getRandomValues`, that convenience API is unavailable on plain-HTTP phone
 * previews because it requires a secure context.
 */
export function createClientTransferId(
  cryptoSource: Pick<Crypto, 'getRandomValues'> = globalThis.crypto,
): string {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  return `ct_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
