// The Run stream (ADR-047): an ordered, resumable log of events, read by
// offset in the Durable Streams style. The runtime-hub writes it to the
// Runtime object store at {orgId}/streams/{runId}; the API serves it after
// the object-level check. The offset is opaque to clients.

export const RUN_STREAM_EVENT_TYPES = ['state', 'phase', 'step.started', 'step.finished', 'verdict', 'published', 'security'] as const;
export type RunStreamEventType = (typeof RUN_STREAM_EVENT_TYPES)[number];

export interface RunStreamEvent {
    type: RunStreamEventType;
    at: string;
    data: Record<string, unknown>;
}

export interface RunStreamPage {
    events: RunStreamEvent[];
    /** Opaque offset to resume from. */
    nextOffset: string;
    upToDate: boolean;
}

export interface RunStreamStore {
    append(orgId: string, runId: string, event: RunStreamEvent): Promise<void>;
    read(orgId: string, runId: string, offset?: string, maxEvents?: number): Promise<RunStreamPage | null>;
}

const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

export class InvalidStreamOffsetError extends Error {}

export const encodeStreamOffset = (n: number) => Buffer.from(`o${n}`).toString('base64url');

/** The position an opaque offset names (0 for the start); anything else is refused. */
export function decodeStreamOffset(offset?: string): number {
    if (!offset || offset === '-1') return 0;
    const raw = Buffer.from(offset, 'base64url').toString();
    const m = /^o(\d{1,15})$/.exec(raw);
    if (!m) throw new InvalidStreamOffsetError('invalid offset');
    return Number(m[1]);
}

/** Validates the tenant and Run ids that name a stream (they become a path or an object key). */
export function streamKeyOf(orgId: string, runId: string): { orgId: string; runId: string } {
    if (!SAFE.test(orgId) || !SAFE.test(runId)) throw new Error('invalid stream key');
    return { orgId, runId };
}
