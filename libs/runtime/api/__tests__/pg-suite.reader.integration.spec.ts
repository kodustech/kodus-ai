import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { PgSuiteReader } from '../infrastructure/pg-suite.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// The suite tables as the product reads them: a role with scripts/runtime/runtime-reader-grants.sql only, inside BEGIN READ ONLY, over
// rows the Runtime's own schema holds. Opt-in: RUNTIME_IT_DATABASE_URL (a superuser on a disposable server).
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_reader');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const ROLE = `suite_reader_${randomBytes(6).toString('hex')}`;
const PASSWORD = randomBytes(24).toString('hex');
const GRANTS = fs.readFileSync(path.join(__dirname, '../../../../scripts/runtime/runtime-reader-grants.sql'), 'utf8').replace(/kodus_runtime_reader/g, ROLE);

const SHA = 'a'.repeat(40);
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 10, day, hour));

(skip ? describe.skip : describe)('PgSuiteReader (real Postgres, the read-only role)', () => {
    let owner: Pool;
    let db: RuntimeReadDb;
    let reader: PgSuiteReader;

    const run = (id: string, over: Record<string, unknown> = {}) => {
        const r = { org: 'org-a', env: 'env-1', mode: 'ci', state: 'failed', pr: 7, requested: at(10), finished: at(10, 11), first: null, rerun: null, selection: {}, ...over };
        return owner.query(
            `INSERT INTO runtime.runtime_suite_runs (suite_run_id, organization_id, environment_id, repository_id, mode, state, pr_number, pr_sha, merge_base, main_sha, selection, requested_at, finished_at, first_pass_ms, rerun_ms, baseline_sha, base_drift)
             VALUES ($1, $2, $3, 'repo-1', $4, $5, $6, $7, $7, $7, $8::jsonb, $9, $10, $11, $12, $7, 2)`,
            [id, r.org, r.env, r.mode, r.state, r.pr, SHA, JSON.stringify(r.selection), r.requested, r.finished, r.first, r.rerun],
        );
    };

    beforeAll(async () => {
        await database.create();
        owner = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(owner);
        await owner.query(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${PASSWORD}'`);
        await owner.query(`GRANT CONNECT ON DATABASE "${new URL(database.url).pathname.slice(1)}" TO "${ROLE}"`);
        await owner.query(GRANTS);
        const restricted = new URL(database.url);
        restricted.username = ROLE;
        restricted.password = PASSWORD;
        db = new RuntimeReadDb(restricted.toString());
        reader = new PgSuiteReader(db);
    });
    afterAll(async () => {
        await db?.onModuleDestroy();
        await owner?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await owner.query(`TRUNCATE runtime.runtime_suite_runs, runtime.runtime_suite_shards, runtime.runtime_suite_results, runtime.runtime_suite_baselines, runtime.runtime_suite_shadows, runtime.runtime_suite_selection_state`);
    });

    describe('one suite run', () => {
        it('reads the run with its plan and its results, and nothing of another organization\'s run', async () => {
            await run('sr-1', { selection: { mode: 'selected', selected: 1, total: 3, reachedBy: { 'src/x.ts': ['a.cy.ts'] } }, first: 660_000, rerun: 180_000 });
            await owner.query(`INSERT INTO runtime.runtime_suite_shards (suite_run_id, shard, organization_id, specs) VALUES ('sr-1', 0, 'org-a', '["a.cy.ts"]'), ('sr-1', 1, 'org-a', '["b.cy.ts"]')`);
            await owner.query(
                `INSERT INTO runtime.runtime_suite_results (suite_run_id, phase, spec, organization_id, shard, status, duration_ms, error_signature, tests, artifacts)
                 VALUES ('sr-1', 'shard', 'a.cy.ts', 'org-a', 0, 'failed', 4000, 'sig', '[{"title":"t","status":"failed","attempts":[{"status":"failed","ms":10,"error":"boom"}]}]', '[{"name":"trace.zip","key":"k","contentType":"application/zip","bytes":9}]'),
                        ('sr-1', 'rerun_main', 'a.cy.ts', 'org-a', 63, 'passed', 100, NULL, '[]', NULL)`,
            );
            const got = await reader.get('org-a', 'sr-1');
            expect(got?.run).toMatchObject({ suiteRunId: 'sr-1', environmentId: 'env-1', mode: 'ci', state: 'failed', prNumber: 7, mainSha: SHA, baselineSha: SHA, baseDrift: 2, firstPassMs: 660_000, rerunMs: 180_000 });
            expect(got?.run.selection).toEqual({ mode: 'selected', selected: 1, total: 3, reachedBy: { 'src/x.ts': ['a.cy.ts'] } });
            expect(got?.run.requestedAt).toBe(at(10).toISOString());
            expect(got?.shards).toEqual([{ shard: 0, specs: ['a.cy.ts'] }, { shard: 1, specs: ['b.cy.ts'] }]);
            expect(got?.results.map((r) => [r.phase, r.spec, r.status, r.artifacts.length])).toEqual([['rerun_main', 'a.cy.ts', 'passed', 0], ['shard', 'a.cy.ts', 'failed', 1]]);
            expect(got?.results.find((r) => r.phase === 'shard')?.tests[0].attempts[0].error).toBe('boom');
            expect(await reader.get('org-b', 'sr-1')).toBeNull();
            expect(await reader.get('org-a', 'nope')).toBeNull();
        });

        it('reads each shard\'s start and end, and the times of the run\'s own hosts only (never another run\'s or org\'s)', async () => {
            await run('sr-h');
            await owner.query(`INSERT INTO runtime.runtime_suite_shards (suite_run_id, shard, organization_id, specs, started_at, finished_at) VALUES ('sr-h', 0, 'org-a', '["a.cy.ts"]', $1, $2)`, [at(10, 10), at(10, 11)]);
            await owner.query(`INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle) VALUES ('p1', 'kodus', 'boat', 'perRun') ON CONFLICT DO NOTHING`);
            await owner.query(`DELETE FROM runtime.runtime_hosts`);
            await owner.query(
                `INSERT INTO runtime.runtime_hosts (host_id, pool_id, provider, state, bound_key, organization_id, created_at, ready_at, terminated_at, usd_per_hour, last_error) VALUES
                 ('h-list', 'p1', 'boat', 'terminated', 'suite:org-a/sr-h/61', 'org-a', $1, $2, $3, 1.5, 'secret detail'),
                 ('h-0', 'p1', 'boat', 'terminated', 'suite:org-a/sr-h/0', 'org-a', $2, $3, NULL, 1.5, NULL),
                 ('h-other', 'p1', 'boat', 'terminated', 'suite:org-a/sr-hx/0', 'org-a', $1, $2, $3, 1.5, NULL),
                 ('h-org', 'p1', 'boat', 'terminated', 'suite:org-b/sr-h/0', 'org-b', $1, $2, $3, 1.5, NULL)`,
                [at(10, 8), at(10, 9), at(10, 12)],
            );
            const got = await reader.get('org-a', 'sr-h');
            expect(got?.shards).toEqual([{ shard: 0, specs: ['a.cy.ts'], startedAt: at(10, 10).toISOString(), finishedAt: at(10, 11).toISOString() }]);
            expect(got?.hosts).toEqual([
                { shard: 61, requestedAt: at(10, 8).toISOString(), readyAt: at(10, 9).toISOString(), endedAt: at(10, 12).toISOString() },
                { shard: 0, requestedAt: at(10, 9).toISOString(), readyAt: at(10, 12).toISOString() },
            ]);
        });

        it('says nothing of machine time for a run stored before it was measured', async () => {
            await run('sr-old');
            const got = await reader.get('org-a', 'sr-old');
            expect(got?.run.firstPassMs).toBeUndefined();
            expect(got?.run.rerunMs).toBeUndefined();
        });
    });

    describe('an environment', () => {
        it('reads the selection state: never counted is on, a person\'s off and a brake are told apart', async () => {
            expect(await reader.selectionState('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
            await owner.query(`INSERT INTO runtime.runtime_suite_selection_state (organization_id, environment_id, off, off_at, off_by, full_prs_left, reenabled_at) VALUES ('org-a', 'env-1', true, now(), 'person', 8, $1)`, [at(9)]);
            expect(await reader.selectionState('org-a', 'env-1')).toEqual({ off: true, offBy: 'person', fullPrsLeft: 8, reenabledAt: at(9).toISOString() });
            expect(await reader.selectionState('org-b', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
        });

        it('reads the newest baseline with its counts, and the newest miss since selection was turned on', async () => {
            const specs = { 'a.cy.ts': { status: 'passed' }, 'b.cy.ts': { status: 'passed' }, 'c.cy.ts': { status: 'failed' } };
            await owner.query(`INSERT INTO runtime.runtime_suite_baselines (organization_id, environment_id, main_sha, suite_digest, status, specs, finished_at) VALUES ('org-a', 'env-1', $1, 'd', 'complete', $2::jsonb, $3), ('org-a', 'env-1', $4, 'd', 'complete', '{}', $5)`, [SHA, JSON.stringify(specs), at(12), 'b'.repeat(40), at(8)]);
            expect(await reader.lastBaseline('org-a', 'env-1')).toEqual({ sha: SHA, specs: 3, passed: 2, failed: 1, finishedAt: at(12).toISOString() });
            expect(await reader.lastBaseline('org-b', 'env-1')).toBeNull();
            const shadow = (id: string, pr: number, misses: string[], finished: Date) =>
                owner.query(
                    `INSERT INTO runtime.runtime_suite_shadows (shadow_run_id, organization_id, environment_id, repository_id, source_run_id, pr_number, pr_sha, merge_base, main_sha, state, selection_misses, conclusive, finished_at)
                     VALUES ($1, 'org-a', 'env-1', 'repo-1', $1 || '-src', $2, $3, $3, $3, 'done', $4::jsonb, true, $5)`,
                    [id, pr, SHA, JSON.stringify(misses), finished],
                );
            await shadow('sh-1', 30, ['old.cy.ts'], at(5));
            await shadow('sh-2', 38, ['e2e/search.spec.ts'], at(11));
            await shadow('sh-3', 39, [], at(12));
            expect(await reader.lastMiss('org-a', 'env-1')).toEqual({ prNumber: 38, specs: ['e2e/search.spec.ts'] });
            // A miss from before selection was turned on again is history.
            expect(await reader.lastMiss('org-a', 'env-1', at(11, 12).toISOString())).toBeNull();
            expect(await reader.lastMiss('org-b', 'env-1')).toBeNull();
        });
    });

    describe('the month\'s usage', () => {
        const window = { start: new Date(Date.UTC(2026, 10, 1)), end: new Date(Date.UTC(2026, 11, 1)) };
        it('groups the month\'s runs by kind with runs, machine time and the runs that re-ran, and leaves out another month and another organization', async () => {
            await run('r1', { mode: 'ci', first: 600_000, rerun: 0 });
            await run('r2', { mode: 'run', first: 300_000, rerun: 120_000 });
            await run('r3', { mode: 'run', first: null, rerun: null });
            await run('b1', { mode: 'baseline', pr: null, first: 900_000, rerun: 0 });
            await run('old', { mode: 'ci', requested: new Date(Date.UTC(2026, 9, 31, 23)), first: 1 });
            await run('other', { mode: 'ci', org: 'org-b', first: 1 });
            const { rows } = await reader.usageOfMonth('org-a', window);
            const by = Object.fromEntries(rows.map((r) => [r.mode, r]));
            expect(by.ci).toEqual({ mode: 'ci', runs: 1, firstPassMs: 600_000, rerunMs: 0, withRerun: 0, unmeasured: 0 });
            expect(by.run).toEqual({ mode: 'run', runs: 2, firstPassMs: 300_000, rerunMs: 120_000, withRerun: 1, unmeasured: 1 });
            expect(by.baseline).toMatchObject({ runs: 1, firstPassMs: 900_000 });
            expect(rows).toHaveLength(3);
        });

        it('measures what selection saved only from shadow pairs where both runs measured their time', async () => {
            await run('sel-1', { mode: 'ci', first: 200_000 });
            await run('full-1', { mode: 'shadow', first: 800_000 });
            await run('sel-2', { mode: 'ci', first: 100_000 });
            await run('full-2', { mode: 'shadow', first: null });
            const shadow = (id: string, source: string, conclusive = true) =>
                owner.query(
                    `INSERT INTO runtime.runtime_suite_shadows (shadow_run_id, organization_id, environment_id, repository_id, source_run_id, pr_number, pr_sha, merge_base, main_sha, state, conclusive, finished_at)
                     VALUES ($1, 'org-a', 'env-1', 'repo-1', $2, 7, $3, $3, $3, 'done', $4, $5)`,
                    [id, source, SHA, conclusive, at(12)],
                );
            await shadow('full-1', 'sel-1');
            await shadow('full-2', 'sel-2');
            expect((await reader.usageOfMonth('org-a', window)).savings).toEqual({ shadowedRuns: 1, savedMs: 600_000 });
            expect((await reader.usageOfMonth('org-b', window)).savings).toEqual({ shadowedRuns: 0, savedMs: 0 });
        });
    });
});
