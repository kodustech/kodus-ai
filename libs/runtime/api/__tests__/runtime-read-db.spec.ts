import { ServiceUnavailableException } from '@nestjs/common';

import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import { PgExternalStopReader } from '../infrastructure/pg-external-stop.reader';
import { PgRuntimeCellReader, PgRuntimeCellTokenReader } from '../infrastructure/pg-runtime-cell.reader';
import { PgRuntimeClaimUsageReader } from '../infrastructure/pg-runtime-claim-usage.reader';
import { PgRuntimeEgressReader } from '../infrastructure/pg-runtime-egress.reader';
import { PgRuntimeMachineUsageReader } from '../infrastructure/pg-runtime-machine-usage.reader';
import { PgRuntimeRunStreamReader } from '../infrastructure/pg-runtime-run-stream.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// The reads themselves run against a real Postgres in runtime-read-db.integration.spec.ts;
// here, the one answer every reader gives when the Runtime database is not configured.

describe('Runtime readers without RUNTIME_DATABASE_READ_URL', () => {
    const db = new RuntimeReadDb(undefined);
    const reads: Array<[string, () => Promise<unknown>]> = [
        ['the cell list', () => new PgRuntimeCellReader(db).listByOrganization('org-a')],
        ['the managed cells', () => new PgRuntimeCellReader(db).listManaged()],
        ['a cell token', () => new PgRuntimeCellTokenReader(db).get('hash')],
        ["a page of Runs' claims", () => new PgRuntimeClaimUsageReader(db).claimsOfRuns('org-a', ['run-1'])],
        ['the blocked egress of Runs', () => new PgRuntimeEgressReader(db).blockedForRuns('org-a', ['run-1'], new Date())],
        ['the egress approvals', () => new PgRuntimeEgressReader(db).approvals('org-a', 'env-1')],
        ['the egress settings', () => new PgRuntimeEgressReader(db).settings('org-a')],
        ['the egress audit', () => new PgRuntimeEgressReader(db).audit('org-a')],
        ["today's machine minutes", () => new PgRuntimeMachineUsageReader(db).today('org-a')],
        ['a Run stream', () => new PgRuntimeRunStreamReader(db).read('org-a', 'run-1')],
        ['the stop state', () => new PgExternalStopReader(db).isStopped('org-a')],
    ];

    it.each(reads)('fails %s with 503 instead of answering empty', async (_what, read) => {
        await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('closes cleanly on shutdown when no read ever opened a pool', async () => {
        await expect(db.onModuleDestroy()).resolves.toBeUndefined();
    });
});

describe('the stop reader', () => {
    it('never reads as not stopped when the Runtime database fails', async () => {
        const failing: SqlQuery = { query: async () => Promise.reject(new Error('connection refused')) };
        await expect(new PgExternalStopReader(failing).isStopped('org-a')).rejects.toThrow('connection refused');
    });
});
