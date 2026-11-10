import { z } from 'zod';

import { MESSAGE_TYPES, MessageBody, MessageBodySchemas, MessageType } from './messages';
import { parseStrictJson, StrictJsonError } from './strict-json';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION - 1, PROTOCOL_VERSION].filter((v) => v > 0);
export const MAX_FRAME_BYTES = 1 << 20;
export const MAX_DEPTH = 32;

export const EnvelopeSchema = z.strictObject({
    v: z.number().int().min(1),
    id: z.uuid(),
    re: z.uuid().optional(),
    cellId: z.string().min(1).max(128),
    claimId: z.string().min(1).max(128).optional(),
    type: z.enum(MESSAGE_TYPES as [MessageType, ...MessageType[]]),
    body: z.unknown(),
});

export type Envelope<T extends MessageType = MessageType> = {
    v: number;
    id: string;
    re?: string;
    cellId: string;
    claimId?: string;
    type: T;
    body: MessageBody<T>;
};

/** Types that act on one claim: the envelope must name it (claimId). */
export const CLAIM_SCOPED_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
    'claim.acquire',
    'claim.ready',
    'claim.failed',
    'claim.renew',
    'claim.release',
    'probe.run',
    'browser.explore',
    'exec',
    'upload',
    'exec.cancel',
    'machine.reset',
    'step.result',
    'step.stream',
    'egress.policy',
    'claim.progress',
]);

/** Types that answer another message: the envelope must name it (re). */
export const REPLY_TYPES: ReadonlySet<MessageType> = new Set<MessageType>(['ack', 'nack']);

/** The envelope fields a type requires, beyond the schema (null: none missing). */
export function missingEnvelopeField(type: MessageType, envelope: { claimId?: string; re?: string }): 'claimId' | 're' | null {
    if (CLAIM_SCOPED_TYPES.has(type) && !envelope.claimId) return 'claimId';
    if (REPLY_TYPES.has(type) && !envelope.re) return 're';
    // blocked answers a request (re), or reports on one claim unsolicited (claimId).
    if (type === 'blocked' && !envelope.re && !envelope.claimId) return 'claimId';
    return null;
}

export type DecodeErrorCode =
    | 'frame_too_large'
    | 'invalid_json'
    | 'duplicate_key'
    | 'too_deep'
    | 'invalid_envelope'
    | 'unsupported_version'
    | 'invalid_body';

export type DecodeResult =
    | { ok: true; message: Envelope }
    | { ok: false; code: DecodeErrorCode; message: string };

/** Decodes one WebSocket frame. Anything refused here gets a nack (S-30). */
export function decodeFrame(raw: string | Buffer): DecodeResult {
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (bytes > MAX_FRAME_BYTES) {
        return { ok: false, code: 'frame_too_large', message: `${bytes} bytes` };
    }

    let parsed: unknown;
    try {
        parsed = parseStrictJson(raw.toString(), MAX_DEPTH);
    } catch (error) {
        if (error instanceof StrictJsonError) {
            return { ok: false, code: error.code, message: error.message };
        }
        throw error;
    }

    const envelope = EnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
        return { ok: false, code: 'invalid_envelope', message: envelope.error.message };
    }
    if (!SUPPORTED_VERSIONS.includes(envelope.data.v)) {
        return { ok: false, code: 'unsupported_version', message: `v${envelope.data.v}` };
    }
    const missing = missingEnvelopeField(envelope.data.type, envelope.data);
    if (missing) {
        return { ok: false, code: 'invalid_envelope', message: `${envelope.data.type} needs ${missing}` };
    }

    const body = MessageBodySchemas[envelope.data.type].safeParse(envelope.data.body);
    if (!body.success) {
        return { ok: false, code: 'invalid_body', message: body.error.message };
    }

    return { ok: true, message: { ...envelope.data, body: body.data } as Envelope };
}

/**
 * zod tuples are closed and every element is required, but toJSONSchema
 * emits `prefixItems` without `items` or `minItems`, which JSON Schema reads
 * as "any length is fine". Say what zod enforces (`items: false` and
 * `minItems`), so a validator that follows the spec refuses what zod
 * refuses. The protocol has no tuple with optional elements.
 */
function closeTuples(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(closeTuples);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = closeTuples(v);
    if (Array.isArray(out.prefixItems)) {
        if (!('items' in out)) out.items = false;
        if (!('minItems' in out)) out.minItems = out.prefixItems.length;
    }
    return out;
}

/** JSON Schema of every message body, for the Go side and the contract tests. */
export function protocolJsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = { envelope: closeTuples(z.toJSONSchema(EnvelopeSchema)) };
    for (const type of MESSAGE_TYPES) {
        out[type] = closeTuples(z.toJSONSchema(MessageBodySchemas[type], { unrepresentable: 'any' }));
    }
    return out;
}
