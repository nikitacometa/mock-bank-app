import { createHash } from 'node:crypto';

const MAX_CANONICAL_JSON_DEPTH = 64;

function normalizeJson(value: unknown, depth: number): unknown {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new TypeError('JSON nesting is too deep');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (typeof value !== 'object') throw new TypeError('Value is not JSON serializable');

  const record = value as Record<string, unknown>;
  // A regular object treats `__proto__` assignment as a prototype mutation,
  // which would silently erase that JSON member and make distinct payloads
  // share one operation hash. A null-prototype record preserves every own key.
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) throw new TypeError('Undefined is not valid JSON');
    normalized[key] = normalizeJson(item, depth + 1);
  }
  return normalized;
}

/** Stable, key-sorted JSON used by operation hashes and response digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, 0));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalJsonDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
