import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ServiceUnavailableException } from '@nestjs/common';

import type { RunStreamEvent } from '@libs/runtime/run';
import { FileRunStreamStore } from '@libs/runtime/run/adapters/file-run-stream.store';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import { PgRuntimeRunStreamReader } from '../infrastructure/pg-runtime-run-stream.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// The Postgres reads themselves run in apps/runtime/src/hub/pg-hub-store.integration.spec.ts
// (RUNTIME_IT_DATABASE_URL); here, the cutover from the file stream.

/** A Runtime Postgres with no row for any Run yet (the Runs were written to the file stream before the switch). */
const noRows: SqlQuery = { query: async () => ({ rows: [] }) };

const event = (n: number): RunStreamEvent => ({ type: 'phase', at: '2026-11-07T00:00:00.000Z', data: { n } });

describe('PgRuntimeRunStreamReader cutover', () => {
    it('reads a Run written before the switch from the file stream, and keeps following its file offsets', async () => {
        const file = new FileRunStreamStore(await fs.mkdtemp(path.join(os.tmpdir(), 'rt-cut-')));
        await file.append('org-1', 'run-1', event(1));
        const reader = new PgRuntimeRunStreamReader(noRows, file);
        const first = (await reader.read('org-1', 'run-1'))!;
        expect(first.events.map((e) => e.data.n)).toEqual([1]);
        await file.append('org-1', 'run-1', event(2));
        expect((await reader.read('org-1', 'run-1', first.nextOffset))!.events.map((e) => e.data.n)).toEqual([2]);
        expect(await reader.read('org-1', 'run-2')).toBeNull();
    });

    it('reads a Run with no row and no file stream as not written; it never writes', async () => {
        const reader = new PgRuntimeRunStreamReader(noRows);
        expect(await reader.read('org-1', 'run-1')).toBeNull();
        await expect(reader.append('org-1', 'run-1', event(1))).rejects.toThrow('does not write');
    });

    it('fails with 503 without the read URL, even with a file stream to fall back to', async () => {
        const file = new FileRunStreamStore(await fs.mkdtemp(path.join(os.tmpdir(), 'rt-cut-')));
        await file.append('org-1', 'run-1', event(1));
        const reader = new PgRuntimeRunStreamReader(new RuntimeReadDb(undefined), file);
        await expect(reader.read('org-1', 'run-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});
