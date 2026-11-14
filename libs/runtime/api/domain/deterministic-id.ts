import { createHash } from 'crypto';

/** Namespace of the Runtime's derived ids (a fixed random UUID). */
const NAMESPACE = Buffer.from('6d0b6f3a5c1e4f2a9b7d3e8c1a2f4b6d', 'hex');

/**
 * A UUID (version 5 layout) derived from its parts: the same parts give the
 * same id. A Run that two deliveries of one event, or two clicks, would each
 * start gets one id, and the Runtime's workflow (keyed by runId) runs it once.
 */
export function deterministicUuid(...parts: Array<string | number>): string {
    const hash = createHash('sha1')
        .update(NAMESPACE)
        .update(parts.map((p) => String(p)).join('\u0000'))
        .digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const h = hash.subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
