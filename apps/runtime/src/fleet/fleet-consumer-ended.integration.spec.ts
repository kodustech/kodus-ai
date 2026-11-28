import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../testing/isolated-database';
import { PgFleetStore } from './fleet-store';

// Opt-in: RUNTIME_IT_DATABASE_URL. The fleet's safety net reads whether the Run or suite run a host is bound to is over
// (docs/runtime/host-providers.md section 7.0), so a claim nobody released never keeps a paid host.
const runtimeDb = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'fleet_consumer_ended');
const skip = !runtimeDb.url || process.env.SKIP_INTEGRATION === 'true';
const GRACE = 5 * 60_000;

(skip ? describe.skip : describe)('whether the consumer of a host is over (real Postgres)', () => {
    let pool: Pool;
    let store: PgFleetStore;

    beforeAll(async () => {
        await runtimeDb.create();
        pool = new Pool({ connectionString: runtimeDb.url, max: 4 });
        await ensureRuntimeSchema(pool);
        store = new PgFleetStore(pool);
    }, 60_000);

    afterAll(async () => {
        await pool?.end();
        await runtimeDb.drop();
    });

    const run = (runId: string, state: string, endedAgoMs: number) =>
        pool.query(`INSERT INTO runtime.runtime_runs (run_id, organization_id, state, finished_at, updated_at) VALUES ($1, 'org-a', $2, now() - ($3::double precision * interval '1 millisecond'), now())`, [runId, state, endedAgoMs]);
    const suite = (suiteRunId: string, endedAgoMs: number | null) =>
        pool.query(
            `INSERT INTO runtime.runtime_suite_runs (suite_run_id, organization_id, environment_id, repository_id, mode, main_sha, requested_at, finished_at)
             VALUES ($1, 'org-a', 'env', 'repo', 'run', 'sha', now(), CASE WHEN $2::double precision IS NULL THEN NULL ELSE now() - ($2::double precision * interval '1 millisecond') END)`,
            [suiteRunId, endedAgoMs],
        );
    const hostWithClaim = async (hostId: string, state: string) => {
        await pool.query(`INSERT INTO runtime.runtime_cells (cell_id, owner, topology, host_id) VALUES ($1, 'kodus', 'single', $2)`, [`cell-${hostId}`, hostId]);
        await pool.query(
            `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, side, state, lease_expires_at, hard_expires_at) VALUES ($1, $2, 'org-a', 'pr', $3, now() + interval '30 minutes', now() + interval '60 minutes')`,
            [`claim-${hostId}`, `cell-${hostId}`, state],
        );
    };

    it('a Run that finished past the grace is over, on either side key or the whole-Run key; one inside the grace, or still running, is not', async () => {
        await run('r-old', 'timed_out', 10 * 60_000);
        await run('r-fresh', 'timed_out', 60_000);
        await run('r-live', 'running', 10 * 60_000);
        expect(await store.consumerEnded('h-1', 'run:org-a/r-old/pr', GRACE)).toBe(true);
        expect(await store.consumerEnded('h-1', 'run:org-a/r-old', GRACE)).toBe(true);
        expect(await store.consumerEnded('h-1', 'run:org-a/r-fresh/pr', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-1', 'run:org-a/r-live/pr', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-1', 'run:org-b/r-old/pr', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-1', 'run:org-a/r-unknown/pr', GRACE)).toBe(false);
    });

    it('a suite run is over once it has a finished_at past the grace; an unfinished one never is', async () => {
        await suite('s-old', 10 * 60_000);
        await suite('s-fresh', 30_000);
        await suite('s-live', null);
        expect(await store.consumerEnded('h-2', 'suite:org-a/s-old/2', GRACE)).toBe(true);
        expect(await store.consumerEnded('h-2', 'suite:org-a/s-fresh/2', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-2', 'suite:org-a/s-live/2', GRACE)).toBe(false);
    });

    it('a setup or template key is never ended here', async () => {
        expect(await store.consumerEnded('h-3', 'template:org-a/env', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-3', 'setup:org-a/key', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-3', 'garbage', GRACE)).toBe(false);
    });

    it('a claim held for diagnosis keeps the host: its machines are evidence', async () => {
        await run('r-held', 'errored', 10 * 60_000);
        await run('r-bound', 'errored', 10 * 60_000);
        await hostWithClaim('h-held', 'held');
        await hostWithClaim('h-bound', 'bound');
        expect(await store.consumerEnded('h-held', 'run:org-a/r-held/pr', GRACE)).toBe(false);
        expect(await store.consumerEnded('h-bound', 'run:org-a/r-bound/pr', GRACE)).toBe(true);
    });
});
