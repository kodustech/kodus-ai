import { decodeStreamOffset, encodeStreamOffset, InvalidStreamOffsetError, type RunStreamEvent, type RunStreamStore, streamKeyOf } from '../run-stream';

/** In-memory stream for tests and the fake driver. */
export class InMemoryRunStreamStore implements RunStreamStore {
    readonly streams = new Map<string, RunStreamEvent[]>();

    async append(orgId: string, runId: string, event: RunStreamEvent) {
        streamKeyOf(orgId, runId);
        const k = `${orgId}/${runId}`;
        this.streams.set(k, [...(this.streams.get(k) ?? []), event]);
    }

    async read(orgId: string, runId: string, offset?: string, maxEvents = 500) {
        const all = this.streams.get(`${orgId}/${runId}`);
        if (!all) return null;
        const start = decodeStreamOffset(offset);
        if (start > all.length) throw new InvalidStreamOffsetError('offset past the end');
        const events = all.slice(start, start + maxEvents);
        const pos = start + events.length;
        return { events, nextOffset: encodeStreamOffset(pos), upToDate: pos >= all.length };
    }
}
