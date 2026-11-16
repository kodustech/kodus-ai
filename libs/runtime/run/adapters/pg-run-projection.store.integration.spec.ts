import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';

import type { RuntimeRunProjection } from '../run-projection';
import { PgRunProjectionStore } from './pg-run-projection.store';
import { PgSql } from './pg-sql';

// The Run projection against a real Postgres (runtime.runtime_runs, v21): what
// only the database guarantees. Opt-in: RUNTIME_IT_DATABASE_URL, in a leased
// database of its own (isolated-database.ts); skipped when none is named.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'run_projection');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('runtime.runtime_runs (integration, real Postgres)', () => {
    let pool: Pool;
    let store: PgRunProjectionStore;
    const org = () => `org-${randomUUID()}`;
    const head = 'b'.repeat(40);

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(pool);
        store = new PgRunProjectionStore(new PgSql(() => pool));
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const queued = (organizationId: string, environmentId: string | undefined, patch: Partial<RuntimeRunProjection> = {}) => {
        const runId = randomUUID();
        return {
            runId,
            write: () =>
                store.upsert(runId, {
                    organizationId,
                    repositoryId: 'repo-1',
                    prNumber: 7,
                    headSha: head,
                    ...(environmentId ? { environmentId } : {}),
                    state: 'queued',
                    requestedAt: new Date().toISOString(),
                    ...patch,
                }),
        };
    };

    it('records a live Run of the same head in each environment, and refuses a second one in the same environment', async () => {
        const o = org();
        await queued(o, 'env-a').write();
        await queued(o, 'env-b').write();
        await expect(queued(o, 'env-a').write()).rejects.toMatchObject({ code: '23505' });
        // A Run recorded before environments were written dedupes against another one without.
        await queued(o, undefined).write();
        await expect(queued(o, undefined).write()).rejects.toMatchObject({ code: '23505' });
    });

    it('a finished Run frees its head for the next one in its environment', async () => {
        const o = org();
        const first = queued(o, 'env-a');
        await first.write();
        await store.upsert(first.runId, { state: 'no_regressions', finishedAt: new Date().toISOString() });
        await expect(queued(o, 'env-a').write()).resolves.toBeUndefined();
        expect((await store.findLive({ organizationId: o, repositoryId: 'repo-1', prNumber: 7 })).map((r) => r.state)).toEqual(['queued']);
    });

    it('each transition keeps what the earlier ones wrote, and a Run of another org reads as absent', async () => {
        const o = org();
        const run = queued(o, 'env-a', { attempt: 1, correlationId: 'corr-1', trigger: 'pull_request', recipe: { sha: head, state: 'found', prChangesRecipe: false } });
        await run.write();
        await store.upsert(run.runId, { state: 'booting', phase: 'capacity', capacityWait: { side: 'base', since: '2026-11-12T10:00:00.000Z', signature: 'no_capacity', message: 'full' } });
        await store.upsert(run.runId, { state: 'testing', capacityWait: null, probes: [{ probeId: 'p1', verdict: 'pass' } as never] });

        const got = await store.get(run.runId, { organizationId: o });
        expect(got).toMatchObject({
            runId: run.runId,
            organizationId: o,
            environmentId: 'env-a',
            attempt: 1,
            correlationId: 'corr-1',
            trigger: 'pull_request',
            state: 'testing',
            phase: 'capacity',
            capacityWait: null,
            recipe: { sha: head, state: 'found', prChangesRecipe: false },
            probes: [{ probeId: 'p1', verdict: 'pass' }],
        });
        expect(await store.get(run.runId, { organizationId: org() })).toBeNull();
    });

    it("lists an org's Runs newest first, by repository, environment, trigger and time, never another org's", async () => {
        const o = org();
        const at = (min: number) => new Date(Date.UTC(2026, 10, 12, 10, min)).toISOString();
        const runs = [
            queued(o, 'env-a', { requestedAt: at(1), state: 'no_regressions' }),
            queued(o, 'env-b', { requestedAt: at(3), state: 'no_regressions', trigger: 'run_again' }),
            queued(o, 'env-a', { requestedAt: at(2), state: 'errored', repositoryId: 'repo-2' }),
        ];
        for (const r of runs) await r.write();
        await queued(org(), 'env-a', { requestedAt: at(4), state: 'errored' }).write();

        const ids = (rs: RuntimeRunProjection[]) => rs.map((r) => r.runId);
        expect(ids(await store.list({ organizationId: o }))).toEqual([runs[1].runId, runs[2].runId, runs[0].runId]);
        expect(ids(await store.list({ organizationId: o, repositoryIds: ['repo-2'] }))).toEqual([runs[2].runId]);
        expect(ids(await store.list({ organizationId: o, repositoryIds: [] }))).toEqual([]);
        expect(ids(await store.list({ organizationId: o, environmentId: 'env-a' }))).toEqual([runs[2].runId, runs[0].runId]);
        expect(ids(await store.list({ organizationId: o, trigger: 'run_again' }))).toEqual([runs[1].runId]);
        expect(ids(await store.list({ organizationId: o, requestedSince: at(2) }))).toEqual([runs[1].runId, runs[2].runId]);
        expect(ids(await store.list({ organizationId: o, limit: 1 }))).toEqual([runs[1].runId]);
        expect((await store.get(runs[0].runId))?.requestedAt).toBe(at(1));
    });
});
