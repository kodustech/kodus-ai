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

    it('a write without a state keeps the state and sets its fields (the start step writes only startedAt)', async () => {
        const o = org();
        const run = queued(o, 'env-a');
        await run.write();
        await store.upsert(run.runId, { startedAt: '2026-11-18T19:47:07.000Z' });

        expect(await store.get(run.runId, { organizationId: o })).toMatchObject({ state: 'queued', startedAt: '2026-11-18T19:47:07.000Z' });
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

    it('a write that lands after a terminal state never makes the Run live again (a stale transition step)', async () => {
        const o = org();
        const run = queued(o, 'env-a');
        await run.write();
        await store.upsert(run.runId, { state: 'booting' });
        // A push supersedes the Run while its workflow's state:testing step is in flight.
        await store.upsert(run.runId, { state: 'superseded', finishedAt: new Date().toISOString() });
        await store.upsert(run.runId, { state: 'testing', phase: 'testing' });
        expect((await store.get(run.runId))?.state).toBe('superseded');
        expect((await store.findLive({ organizationId: o, repositoryId: 'repo-1', prNumber: 7 })).map((r) => r.runId)).not.toContain(run.runId);
        // The same terminal state written again (a retried step) is fine.
        await expect(store.upsert(run.runId, { state: 'superseded' })).resolves.toBeUndefined();
    });

    it('a move to another state after a terminal one writes none of its columns, and says so (v-core N6)', async () => {
        const o = org();
        const run = queued(o, 'env-a');
        await run.write();
        expect(await store.moveState(run.runId, { state: 'testing' })).toBe(true);
        await store.upsert(run.runId, { state: 'superseded', check: { conclusion: 'cancelled', title: 'Superseded by a newer push' } });
        expect(await store.moveState(run.runId, { state: 'regression', check: { conclusion: 'failure', title: '1 regression' }, finishedAt: new Date().toISOString() })).toBe(false);
        expect(await store.get(run.runId)).toMatchObject({ state: 'superseded', check: { conclusion: 'cancelled' } });
        // The same terminal state again (a step that died after its write) moves.
        expect(await store.moveState(run.runId, { state: 'superseded' })).toBe(true);
    });

    it('lists every live Run of every org, past 1,000 of them', async () => {
        const o = org();
        const total = 1_205;
        await pool.query(
            `INSERT INTO runtime.runtime_runs (run_id, organization_id, repository_id, pr_number, head_sha, state, requested_at, updated_at, report)
             SELECT gen_random_uuid()::text, $1, 'repo-' || n, n, $2, 'awaiting_approval', now(), now(), '{}'::jsonb FROM generate_series(1, $3) AS n`,
            [o, head, total],
        );
        expect((await store.listLive(o)).length).toBe(total);
        expect((await store.listLive()).filter((r) => r.organizationId === o).length).toBe(total);
    });

    it("keeps the PR title in the Run's report, read back by the list and the detail; an older Run has none", async () => {
        const o = org();
        const titled = queued(o, 'env-a', { prTitle: "fix(orders): coupon total, 'quoted' \"too\" 🚀", state: 'no_regressions' });
        const older = queued(o, 'env-b', { state: 'no_regressions' });
        await titled.write();
        await older.write();
        // A later transition keeps it.
        await store.upsert(titled.runId, { state: 'no_regressions', finishedAt: new Date().toISOString() });

        expect((await store.get(titled.runId, { organizationId: o }))?.prTitle).toBe("fix(orders): coupon total, 'quoted' \"too\" 🚀");
        const listed = await store.list({ organizationId: o });
        expect(listed.find((r) => r.runId === titled.runId)?.prTitle).toBe("fix(orders): coupon total, 'quoted' \"too\" 🚀");
        expect(listed.find((r) => r.runId === older.runId)).not.toHaveProperty('prTitle');
        // Not a column: it is display text, never filtered or sorted on.
        const row = await pool.query(`SELECT report->>'prTitle' AS title FROM runtime.runtime_runs WHERE run_id = $1`, [titled.runId]);
        expect(row.rows[0].title).toBe("fix(orders): coupon total, 'quoted' \"too\" 🚀");
    });
});
