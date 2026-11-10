import { promises as fs } from 'fs';
import * as path from 'path';

import { decodeStreamOffset, encodeStreamOffset, InvalidStreamOffsetError, type RunStreamEvent, type RunStreamPage, type RunStreamStore, streamKeyOf } from '../run-stream';

/** How much of the file one read takes at most; a page stops at the last whole line in it. */
const READ_CHUNK_BYTES = 1 << 20;

/**
 * Filesystem object store (a volume locally and in self-hosted); S3 is the
 * same contract. The offset is the byte position after the last line served,
 * so a read starts there instead of loading the whole stream again.
 */
export class FileRunStreamStore implements RunStreamStore {
    private readonly chains = new Map<string, Promise<void>>();

    constructor(private readonly root: string) {}

    private files(orgId: string, runId: string) {
        streamKeyOf(orgId, runId);
        const dir = path.join(this.root, orgId, 'streams');
        return { dir, file: path.join(dir, `${runId}.jsonl`) };
    }

    async append(orgId: string, runId: string, event: RunStreamEvent): Promise<void> {
        const { dir, file } = this.files(orgId, runId);
        const line = JSON.stringify(event) + '\n';
        const prev = this.chains.get(file) ?? Promise.resolve();
        const next = prev.then(async () => {
            await fs.mkdir(dir, { recursive: true });
            await fs.appendFile(file, line, 'utf8');
        });
        const settled = next.catch(() => undefined);
        this.chains.set(file, settled);
        // Drop the chain once it is the last one queued: the map holds only streams being written.
        void settled.then(() => {
            if (this.chains.get(file) === settled) this.chains.delete(file);
        });
        return next;
    }

    async read(orgId: string, runId: string, offset?: string, maxEvents = 500): Promise<RunStreamPage | null> {
        const { file } = this.files(orgId, runId);
        const start = decodeStreamOffset(offset);
        let handle: fs.FileHandle;
        try {
            handle = await fs.open(file, 'r');
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
            throw e;
        }
        try {
            const size = (await handle.stat()).size;
            if (start > size) throw new InvalidStreamOffsetError('offset past the end');
            if (start > 0) {
                // A served offset always sits right after a newline; any other position is forged.
                const prev = Buffer.alloc(1);
                await handle.read(prev, 0, 1, start - 1);
                if (prev[0] !== 0x0a) throw new InvalidStreamOffsetError('offset is not at the start of an event');
            }
            const length = Math.min(READ_CHUNK_BYTES, size - start);
            const buf = Buffer.alloc(length);
            if (length > 0) await handle.read(buf, 0, length, start);
            const events: RunStreamEvent[] = [];
            let pos = 0;
            while (pos < buf.length && events.length < maxEvents) {
                const nl = buf.indexOf(0x0a, pos);
                if (nl < 0) break;
                events.push(JSON.parse(buf.subarray(pos, nl).toString('utf8')));
                pos = nl + 1;
            }
            if (pos === 0 && length === READ_CHUNK_BYTES) throw new Error(`a stream event is larger than ${READ_CHUNK_BYTES} bytes`);
            const next = start + pos;
            return { events, nextOffset: encodeStreamOffset(next), upToDate: next >= size };
        } finally {
            await handle.close();
        }
    }
}
