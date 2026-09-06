import { describe, expect, it } from 'vitest';
import { createClientMutationId, isClientMutationId } from './clientMutationId';

describe('client mutation id', () => {
  it('creates a lowercase 128-bit retry key without randomUUID', () => {
    const cryptoWithoutRandomUuid = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (!(array instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
        array.forEach((_, index) => {
          array[index] = 255 - index;
        });
        return array;
      },
    };

    const id = createClientMutationId(cryptoWithoutRandomUuid);

    expect(id).toBe('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0');
    expect(isClientMutationId(id)).toBe(true);
    expect(isClientMutationId(id.toUpperCase())).toBe(false);
  });
});
