import { describe, expect, it } from 'vitest';
import { createClientTransferId } from './clientTransferId';

describe('createClientTransferId', () => {
  it('creates a client transfer id when randomUUID is unavailable', () => {
    const cryptoWithoutRandomUuid = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (!(array instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
        array.forEach((_, index) => {
          array[index] = index;
        });
        return array;
      },
    };

    expect(createClientTransferId(cryptoWithoutRandomUuid)).toBe(
      'ct_000102030405060708090a0b0c0d0e0f',
    );
  });
});
