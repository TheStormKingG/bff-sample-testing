/**
 * Canonical JSON serialisation — the input to every payload hash.
 *
 * Idempotency compares a stored payload hash against an incoming one
 * (PRD §10.3). If the serialisation were key-order dependent, two byte-wise
 * identical submissions sent by two different clients would hash differently
 * and the "same key, same payload" replay guarantee would silently degrade
 * into "same key, different payload → rejected". So key order is fixed, and
 * every value whose textual form is ambiguous is either normalised or refused.
 *
 * PURE: no Deno, no npm/jsr, no I/O.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalisationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path === '' ? '<root>' : path}`);
    this.name = 'CanonicalisationError';
    this.path = path;
  }
}

/**
 * A number is only canonical if it is finite. NaN and ±Infinity both stringify
 * to `null` through `JSON.stringify`, which would make a corrupt measurement
 * hash identically to an absent one — and rule 8 of the build contract turns on
 * blank and zero never being conflated. Refusing is the only safe answer.
 */
function encodeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalisationError(
      `Non-finite number ${String(value)} cannot be canonicalised`,
      path,
    );
  }
  // -0 and 0 are the same measured quantity; String() would distinguish them.
  return value === 0 ? '0' : String(value);
}

function encodeString(value: string): string {
  // JSON.stringify on a lone string is already canonical: shortest escapes,
  // double quotes, \uXXXX for control characters.
  return JSON.stringify(value);
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return encodeString(value);
    case 'number':
      return encodeNumber(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalisationError('bigint is not representable in JSON', path);
    case 'function':
    case 'symbol':
      throw new CanonicalisationError(`${typeof value} is not serialisable`, path);
    case 'undefined':
      // Only reachable for an array hole; object properties are filtered out
      // before recursion. An absent array element becomes null, as in JSON.
      return 'null';
    default:
      break;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalisationError('Invalid Date cannot be canonicalised', path);
    }
    return encodeString(value.toISOString());
  }

  const asObject = value as object;
  if (seen.has(asObject)) {
    throw new CanonicalisationError('Circular reference', path);
  }
  seen.add(asObject);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item, i) => encode(item, `${path}[${i}]`, seen));
      return `[${parts.join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    // Sort by UTF-16 code unit, which is what Array.prototype.sort does by
    // default and what every other canonical-JSON profile uses. Locale-aware
    // collation would make the hash depend on the runtime's ICU data.
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => `${encodeString(k)}:${encode(record[k], path === '' ? k : `${path}.${k}`, seen)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(asObject);
  }
}

/** Deterministic JSON text for `value`. Throws on anything ambiguous. */
export function canonicalise(value: unknown): string {
  return encode(value, '', new Set<object>());
}
