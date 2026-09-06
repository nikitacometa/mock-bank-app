import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalJsonDigest } from './canonical-json.js';

describe('canonicalJson', () => {
  it('preserves a parsed own __proto__ key so distinct operations cannot share a fingerprint', () => {
    const withProtoKey: unknown = JSON.parse('{"value":1,"__proto__":{"role":"admin"}}');
    const withoutProtoKey: unknown = JSON.parse('{"value":1}');

    expect(canonicalJson(withProtoKey)).toBe('{"__proto__":{"role":"admin"},"value":1}');
    expect(canonicalJsonDigest(withProtoKey)).not.toBe(canonicalJsonDigest(withoutProtoKey));
  });

  it('preserves nested parsed __proto__ keys while sorting every object level', () => {
    const value: unknown = JSON.parse(
      '{"z":{"tail":2,"__proto__":{"b":2,"a":1}},"a":0}',
    );

    expect(canonicalJson(value)).toBe(
      '{"a":0,"z":{"__proto__":{"a":1,"b":2},"tail":2}}',
    );
  });
});
