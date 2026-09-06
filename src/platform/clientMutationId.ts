const CLIENT_MUTATION_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isClientMutationId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_MUTATION_ID_PATTERN.test(value);
}

export function createClientMutationId(
  cryptoSource: Pick<Crypto, 'getRandomValues'> = globalThis.crypto,
): string {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
