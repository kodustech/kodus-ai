import { randomBytes } from 'crypto';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { PgRuntimeSpeedReader } from '../infrastructure/pg-runtime-speed.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// Opt-in: runs against RUNTIME_IT_DATABASE_URL, skipped without it.
const base = process.env.RUNTIME_IT_DATABASE_URL;
const database = isolatedDatabase(base ?? '', 'speed_reader');

(base && process.env.SKIP_INTEGRATION !== 'true' ? describe : describe.skip)('speed reader (integration, real Postgres)', () => {
    let owner: Pool;
    let reader: PgRuntimeSpeedReader;
    let readDb: RuntimeReadDb;
    const T = Date.parse('2026-11-16T10:00:00.000Z');
    const at = (s: number) => new Date(T + s * 1000);

    beforeAll(async () => {
        await database.create();
        owner = new Pool({ connectionString: database.url, max: 2 });
        owner.on('error', () => undefined);
        await ensureRuntimeSchema(owner);
        // The API's read role, with SELECT on the tables scripts/runtime/runtime-reader-grants.sql grants.
        const role = `speed_reader_${randomBytes(6).toString('hex')}`;
        const password = randomBytes(24).toString('hex');
        await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
        await owner.query(`GRANT USAGE ON SCHEMA runtime TO "${role}"`);
        await owner.query(`GRANT SELECT ON runtime.runtime_runs, runtime.runtime_run_events, runtime.runtime_claims, runtime.runtime_cells TO "${role}"`);
        const restricted = new URL(database.url);
        restricted.username = role;
        restricted.password = password;
        readDb = new RuntimeReadDb(restricted.toString());
        reader = new PgRuntimeSpeedReader(readDb);

        await owner.query(`INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology) VALUES ('cell-k', NULL, 'kodus', 'shared'), ('cell-c', 'org-1', 'customer', 'dedicated')`);
        const runRow = (runId: string, org: string, state: string, requested: Date) =>
            owner.query(
                `INSERT INTO runtime.runtime_runs (run_id, organization_id, environment_id, state, requested_at, started_at, finished_at, updated_at)
                 VALUES ($1, $2, 'env-a', $3, $4::timestamptz, $4::timestamptz + interval '2 seconds', $4::timestamptz + interval '90 seconds', now())`,
                [runId, org, state, requested],
            );
        await runRow('run-1', 'org-1', 'no_regressions', at(0));
        await runRow('run-old', 'org-1', 'no_regressions', new Date(T - 40 * 86_400_000));
        await runRow('run-other', 'org-2', 'regression', at(0));
        const claim = (id: string, org: string, runId: string, side: string, cell: string, start: string | null, ready: boolean) =>
            owner.query(
                `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, run_id, side, state, lease_expires_at, hard_expires_at, start_source, ready_at)
                 VALUES ($1, $2, $3, $4, $5, 'released', now(), now(), $6, CASE WHEN $7::boolean THEN now() END)`,
                [id, cell, org, runId, side, start, ready],
            );
        await claim('c-base', 'org-1', 'run-1', 'base', 'cell-k', 'pool', true);
        await claim('c-pr', 'org-1', 'run-1', 'pr', 'cell-c', 'cold', true);
        await claim('c-pr-failed', 'org-1', 'run-1', 'pr', 'cell-k', 'pool', false);
        const event = (org: string, runId: string, type: string, data: object, createdAt: Date) =>
            owner.query(`INSERT INTO runtime.runtime_run_events (org_id, run_id, event, created_at) VALUES ($1, $2, $3, $4)`, [org, runId, JSON.stringify({ type, at: createdAt.toISOString(), data }), createdAt]);
        await event('org-1', 'run-1', 'step.started', { stepId: 's0', kind: 'exec', side: 'base' }, at(5));
        await event('org-1', 'run-1', 'step.started', { stepId: 's1', kind: 'probe', side: 'base', probeId: 'p1' }, at(20));
        await event('org-1', 'run-1', 'step.started', { stepId: 's2', kind: 'probe', side: 'base', probeId: 'p2' }, at(25));
        await event('org-1', 'run-1', 'step.started', { stepId: 's3', kind: 'probe', side: 'pr', probeId: 'p1' }, at(40));
        // Another org's event on the same run id never counts.
        await event('org-2', 'run-1', 'step.started', { stepId: 's9', kind: 'probe', side: 'pr', probeId: 'p1' }, at(1));
    });

    afterAll(async () => {
        await readDb?.onModuleDestroy();
        await owner?.end();
        await database.drop();
    });

    it("reads the org's Runs of the window with each side's first probe, start source and cell owner of its ready claims", async () => {
        const rows = await reader.speedRuns('org-1', new Date(T - 7 * 86_400_000));
        expect(rows).toEqual([
            {
                runId: 'run-1',
                environmentId: 'env-a',
                state: 'no_regressions',
                requestedAt: at(0).toISOString(),
                startedAt: at(2).toISOString(),
                finishedAt: at(90).toISOString(),
                firstProbeAt: { base: at(20).toISOString(), pr: at(40).toISOString() },
                sideStarts: ['pool', 'cold'],
                sideOwners: ['kodus', 'customer'],
            },
        ]);
    });

    it('stops at the limit, the newest first', async () => {
        const rows = await reader.speedRuns('org-1', new Date(T - 60 * 86_400_000), 1);
        expect(rows.map((r) => r.runId)).toEqual(['run-1']);
    });
});
