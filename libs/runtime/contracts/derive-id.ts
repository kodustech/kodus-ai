import { createHash } from 'crypto';

// Ids, idempotency keys and digests the Runtime derives from their inputs.
// They are stored and compared across processes and releases (claim rows,
// DBOS step and workflow ids, lessons, previews, image keys, payload hashes),
// so a shipped derivation never changes: apps/runtime/src/shared/derived-ids.golden.spec.ts
// pins each one. A new id uses deriveId; the other schemes here are the ones
// shipped ids already use, kept byte for byte.

/** The sha256 of a UTF-8 string. */
export const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** The sha256 of a UTF-8 string as hex, cut to `hexLen` characters when given. */
export const sha256Hex = (text: string, hexLen?: number): string => {
    const hex = sha256(text).toString('hex');
    return hexLen === undefined ? hex : hex.slice(0, hexLen);
};

/**
 * The sha256 of the parts joined with NUL (the first part is the namespace,
 * when the id has one). The scheme of the shipped ids: unambiguous only while
 * no part contains a NUL, which their parts (ids, keys, shas) never do.
 */
export const nulJoinedDigest = (parts: readonly (string | number)[]): Buffer => sha256(parts.join('\0'));

/** nulJoinedDigest as hex, cut to `hexLen` characters when given. */
export const nulJoinedHex = (parts: readonly (string | number)[], hexLen?: number): string => {
    const hex = nulJoinedDigest(parts).toString('hex');
    return hexLen === undefined ? hex : hex.slice(0, hexLen);
};

/** The sha256 hex of the parts as a JSON array: unambiguous for any string. */
export const jsonTupleHex = (parts: readonly unknown[]): string => sha256Hex(JSON.stringify(parts));

/**
 * A new id: sha256 over the namespace and each part, every one prefixed with
 * its byte length, so no part's content (a NUL, a separator) can make two
 * different inputs collide. Use this for an id that has never shipped.
 */
export function deriveId(namespace: string, parts: readonly string[], hexLen = 64): string {
    const h = createHash('sha256');
    for (const p of [namespace, ...parts]) h.update(`${Buffer.byteLength(p, 'utf8')}:`).update(p, 'utf8');
    return h.digest('hex').slice(0, hexLen);
}

/**
 * A UUID-shaped id from a digest: its first 16 bytes with version 5 and
 * variant 10xx (the RFC 9562 §5.5 layout). Over a sha256 digest it is not a
 * true UUIDv5 (SHA-1); RFC 9562 would call that UUIDv8 (§5.8).
 */
export function uuidV5From(digest: Buffer): string {
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The suite run a Run's e2e stage is (docs/runtime/e2e-suites.md section 10.2): the worker names it when the stage starts, and the
 * product reads the Run's suite under the same id. One derivation for both, so a Run page never looks for a suite the engine named otherwise.
 */
export const suiteRunIdOfRun = (organizationId: string, runId: string): string => uuidV5From(sha256(`suite-run:${organizationId}:${runId}`));

/**
 * A UUID-shaped id from a hex digest, the setup ids' layout: the version
 * nibble replaced by 4 and the variant nibble by 8 (not uuidV5From's masking;
 * both are shipped).
 */
export function uuidV4ShapeFrom(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, undefined members
 * dropped, no whitespace. The same value with its keys in another order (a
 * JSONB round trip, another transport) encodes the same. Shipped quirk, kept:
 * an undefined array element encodes as nothing (`[1,,2]`), not `null`.
 */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
            .join(',')}}`;
    return JSON.stringify(value);
}

/**
 * Plain JSON.stringify, named where a stored key is built from it: NOT
 * canonical (object keys keep their insertion order, an undefined array
 * element is null). The plan reuse key shipped on it; canonicalJson would change it.
 */
export const insertionOrderJson = (value: unknown): string => JSON.stringify(value);
