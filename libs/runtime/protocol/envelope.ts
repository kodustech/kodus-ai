import { z } from 'zod';

import { TraceparentSchema } from '@libs/runtime/contracts/trace-context';

import { MESSAGE_TYPES, MessageBody, MessageBodySchemas, MessageType } from './messages';
import { parseStrictJson, StrictJsonError } from './strict-json';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION - 1, PROTOCOL_VERSION].filter((v) => v > 0);

/**
 * The version skew policy, as Kubernetes has it for the kubelet: a cell is
 * never newer than the hub it dials, and never older than the oldest
 * protocol the hub still speaks. A hub of protocol H accepts a cell whose
 * hello offers at most H and at least MIN_CELL_PROTOCOL_VERSION (H - 1),
 * chooses the cell's highest version, and frames that session in it.
 * So the hub is upgraded first, then its cells, one protocol at a time.
 *
 * Raising PROTOCOL_VERSION keeps the version before it served only while
 * the hub still sends that version's bodies to a session that chose it;
 * a hub that cannot raises MIN_CELL_PROTOCOL_VERSION with it.
 */
export const MIN_CELL_PROTOCOL_VERSION = SUPPORTED_VERSIONS[0];

/** The nack codes of a hello refused for its protocol version (an older hub sent unsupported_version for both). */
export const HELLO_VERSION_REFUSALS = { cellTooOld: 'cell_too_old', cellTooNew: 'cell_too_new' } as const;
export type HelloVersionRefusalCode = (typeof HELLO_VERSION_REFUSALS)[keyof typeof HELLO_VERSION_REFUSALS];

/** The cell protocol versions a hub accepts at hello: this hub's by default. */
export type CellProtocolRange = { min: number; max: number };
const HUB_CELL_PROTOCOLS: CellProtocolRange = { min: MIN_CELL_PROTOCOL_VERSION, max: PROTOCOL_VERSION };

/** The protocol a hello's cell speaks: the highest version it offers (it frames in that one). */
export function cellProtocolOf(versions: readonly number[]): number {
    return Math.max(...versions);
}

/**
 * Why a hub refuses a hello for its versions, or null when it accepts it.
 * The message is for the operator who reads the cell's log: what each side
 * speaks, what the hub accepts, and which side to upgrade.
 */
export function helloVersionRefusal(versions: readonly number[], range: CellProtocolRange = HUB_CELL_PROTOCOLS): { code: HelloVersionRefusalCode; message: string } | null {
    const cell = cellProtocolOf(versions);
    const accepts = `this hub (protocol v${range.max}) accepts cells of protocol v${range.min} to v${range.max}`;
    if (cell > range.max) {
        return { code: HELLO_VERSION_REFUSALS.cellTooNew, message: `cell speaks protocol v${cell}; ${accepts}: a cell is never newer than its hub, so upgrade the hub first or install a cell release of protocol v${range.max}` };
    }
    if (cell < range.min) {
        return { code: HELLO_VERSION_REFUSALS.cellTooOld, message: `cell speaks protocol v${cell}; ${accepts}: upgrade the cell` };
    }
    return null;
}
export const MAX_FRAME_BYTES = 1 << 20;
export const MAX_DEPTH = 32;

export const EnvelopeSchema = z.strictObject({
    v: z.number().int().min(1),
    id: z.uuid(),
    re: z.uuid().optional(),
    cellId: z.string().min(1).max(128),
    claimId: z.string().min(1).max(128).optional(),
    /**
     * W3C trace context of the work the frame is part of (the hub's span that
     * sent it). Sent only to a cell whose hello names the feature traceContext,
     * and by the cell only to its guest agent: an older strict decoder refuses
     * the field. Never chooses anything but the span's parent.
     */
    traceparent: TraceparentSchema.optional(),
    type: z.enum(MESSAGE_TYPES as [MessageType, ...MessageType[]]),
    body: z.unknown(),
});

export type Envelope<T extends MessageType = MessageType> = {
    v: number;
    id: string;
    re?: string;
    cellId: string;
    claimId?: string;
    traceparent?: string;
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
    'sandbox.acquire',
    'sandbox.op',
    'preview.route',
    'preview.unroute',
    'claim.snapshot',
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
    // A hello is decoded whatever its version: its envelope and body are what
    // every protocol version keeps, so a hub can tell a cell of any version
    // why it refuses it (helloVersionRefusal) instead of leaving it unanswered.
    if (envelope.data.type !== 'hello' && !SUPPORTED_VERSIONS.includes(envelope.data.v)) {
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
