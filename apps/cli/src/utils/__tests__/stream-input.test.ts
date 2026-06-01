import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readStreamPayload } from '../stream-input.js';

function createStream(): PassThrough & { isTTY?: boolean } {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
    stream.isTTY = false;
    return stream;
}

describe('readStreamPayload', () => {
    it('returns empty string for tty streams', async () => {
        const stream = createStream();
        stream.isTTY = true;

        await expect(readStreamPayload(stream)).resolves.toBe('');
    });

    it('preserves unrelated listeners on the same stream', async () => {
        const stream = createStream();
        const observedChunks: string[] = [];

        stream.on('data', (chunk: Buffer | string) => {
            observedChunks.push(chunk.toString());
        });

        const payload = readStreamPayload(stream, {
            noDataTimeoutMs: 50,
            brokenStreamTimeoutMs: 200,
        });

        stream.write('payload');
        stream.end();

        await expect(payload).resolves.toBe('payload');
        expect(observedChunks).toEqual(['payload']);
        expect(stream.listenerCount('data')).toBe(1);
    });
});
