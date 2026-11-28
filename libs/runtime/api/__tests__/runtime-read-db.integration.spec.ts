import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { Pool } from 'pg';

import { PgLessonStore } from '@libs/runtime/blockers/pg-lesson.store';
import type { RuntimeRunProjection } from '@libs/runtime/run';
import { PgEnvironmentSetupStore } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { PgRunProjectionStore, RUN_COLUMNS } from '@libs/runtime/run/adapters/pg-run-projection.store';
import { PgSql } from '@libs/runtime/run/adapters/pg-sql';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { PgPullRequestRunsReader } from '../infrastructure/pg-pull-request-runs.reader';
import { PgRuntimeCellTokenReader } from '../infrastructure/pg-runtime-cell.reader';
import { PgRuntimeEgressReader } from '../infrastructure/pg-runtime-egress.reader';
import { PgCommandStore } from '../../../../apps/runtime/src/shared/persistence/pg-command-store';
import { PgLessonReader, ProjectionEnvironmentReader, ReadOnlyRunProjectionStore } from '../infrastructure/pg-runtime-readers';
import { RUNTIME_READ_POOL_MAX, RuntimeReadDb } from '../infrastructure/runtime-read-db';

// What the API reads of the Runtime Postgres, as the API reads it: the role
// kodus_runtime_reader with scripts/runtime/runtime-reader-grants.sql, inside
// BEGIN READ ONLY (RuntimeReadDb). The runtime-worker's stores write the rows
// with the owner's connection. Opt-in: RUNTIME_IT_DATABASE_URL (a superuser
// on a disposable server, kr-it-pg locally), in a leased database of its own.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'runtime_read_db');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const GRANTS = fs.readFileSync(path.join(__dirname, '../../../../scripts/runtime/runtime-reader-grants.sql'), 'utf8');
const READER_PASSWORD = `it-${randomUUID()}`;

(skip ? describe.skip : describe)('the API reads the Runtime Postgres with its read-only role (integration, real Postgres)', () => {
    let owner: Pool;
    let readerUrl: string;
    let db: RuntimeReadDb;

    beforeAll(async () => {
        await database.create();
        owner = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(owner);
        // The role is the server's (roles are cluster-wide): made once, its password set for this run.
        await owner.query(`DO $$ BEGIN CREATE ROLE kodus_runtime_reader LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await owner.query(`ALTER ROLE kodus_runtime_reader LOGIN NOSUPERUSER PASSWORD '${READER_PASSWORD}'`);
        const name = new URL(database.url).pathname.slice(1);
        await owner.query(`GRANT CONNECT ON DATABASE "${name}" TO kodus_runtime_reader`);
        await owner.query(GRANTS);
        const u = new URL(database.url);
        u.username = 'kodus_runtime_reader';
        u.password = READER_PASSWORD;
        readerUrl = u.toString();
        db = new RuntimeReadDb(readerUrl);
    });
    afterAll(async () => {
        await db?.onModuleDestroy();
        await owner?.end();
        await database.drop();
    });

    const org = () => `org-${randomUUID()}`;
    const writer = () => new PgRunProjectionStore(new PgSql(() => owner));
    const at = (min: number) => new Date(Date.UTC(2026, 10, 12, 10, min)).toISOString();
    /** A projection's typed columns only (pg-run-projection.store.ts RUN_COLUMNS). */
    const pick = (r: RuntimeRunProjection) => Object.fromEntries(Object.entries(r).filter(([k]) => RUN_COLUMNS.specs.some(([f]) => f === k)));
    const run = (organizationId: string, patch: Partial<RuntimeRunProjection>): Partial<RuntimeRunProjection> => ({
        organizationId,
        teamId: 'team-1',
        repositoryId: 'repo-1',
        prNumber: 7,
        headSha: 'a'.repeat(40),
        environmentId: 'env-1',
        imageId: 'img-1',
        attempt: 1,
        state: 'no_regressions',
        ...patch,
    });

    it("reads the Run projection, an environment's setup and the org's lessons the runtime-worker wrote", async () => {
        const o = org();
        const runId = randomUUID();
        await writer().upsert(runId, run(o, { requestedAt: at(1), correlationId: 'c' }));
        const env = randomUUID();
        await new PgEnvironmentSetupStore(new PgSql(() => owner)).save({
            environmentId: env,
            organizationId: o,
            repositoryId: 'repo-1',
            key: 'k',
            state: 'active',
            steps: [],
            blockers: [],
            imageId: 'img-setup',
            expose: [{ service: 'web', port: 3000 } as never],
            requestedAt: at(0),
            updatedAt: at(2),
        });
        await writer().upsert(randomUUID(), run(o, { environmentId: env, requestedAt: at(3) }));
        await new PgLessonStore(new PgSql(() => owner)).record({
            lessonId: randomUUID(),
            organizationId: o,
            scope: 'repo',
            repositoryId: 'repo-1',
            environmentId: env,
            signature: 's',
            kind: 'missing_env',
            problem: 'p',
            cause: 'c',
            fix: { id: 'f', action: 'set_env' as never, summary: 's' },
            origin: { sha: 'c'.repeat(40), blockedSetupKey: 'a', fixedSetupKey: 'b', at: at(0) },
            helped: 1,
            state: 'active',
            firstAt: at(0),
            lastAt: at(0),
        });

        const projection = new ReadOnlyRunProjectionStore(db);
        expect(await projection.get(runId, { organizationId: o }, { timeoutMs: 2000 })).toMatchObject({ runId, correlationId: 'c', requestedAt: at(1) });
        expect(await new ProjectionEnvironmentReader(db).get(o, env)).toEqual({
            environmentId: env,
            organizationId: o,
            teamId: 'team-1',
            repositoryId: 'repo-1',
            imageId: 'img-setup',
            expose: [{ service: 'web', port: 3000 }],
        });
        expect(await new ProjectionEnvironmentReader(db).get(org(), env)).toBeNull();
        expect((await new PgLessonReader(db).listByOrganization(o)).map((l) => l.signature)).toEqual(['s']);
    });

    it("the pull requests screens get the latest Run of each of a PR's newest commits, at most the number asked, without the probes' evidence", async () => {
        const o = org();
        const probe = { probeId: 'p1', entryPoint: 'GET /orders', verdict: 'regression', intent: 'changed', baseStepIds: ['b'], prStepIds: ['p'], lanes: { base: {} } };
        // PR 1: commits a, c and b, b run again last; PR 2: one commit. A re-run never pushes an older commit out.
        for (const [pr, min, sha] of [[1, 1, 'a'], [1, 3, 'c'], [1, 2, 'b'], [1, 4, 'b'], [2, 5, 'a']] as const) {
            await writer().upsert(randomUUID(), run(o, { prNumber: pr, headSha: sha.repeat(40), requestedAt: at(min), findings: [probe as never], probes: [probe as never], reproduction: { probes: [{ probeId: 'p1', purpose: 'Orders list the quantity', spec: { kind: 'sql' } }] } as never }));
        }
        await writer().upsert(randomUUID(), run(org(), { prNumber: 1, requestedAt: at(9) }));

        const got = await new PgPullRequestRunsReader(db).listForPullRequests({ organizationId: o, pullRequests: [{ repositoryId: 'repo-1', prNumber: 1 }, { repositoryId: 'repo-1', prNumber: 2 }], perPullRequest: 3 });
        expect(got.map((r) => [r.prNumber, r.requestedAt])).toEqual([[1, at(4)], [1, at(3)], [1, at(1)], [2, at(5)]]);
        expect(got[0].probes).toEqual([{ probeId: 'p1', entryPoint: 'GET /orders', verdict: 'regression', intent: 'changed' }]);
        expect(got[0].findings).toEqual([{ probeId: 'p1', entryPoint: 'GET /orders', verdict: 'regression', intent: 'changed' }]);
        expect(got[0].reproduction).toEqual({ probes: [{ probeId: 'p1', purpose: 'Orders list the quantity' }] });
        expect(got[0]).not.toHaveProperty('correlationId');
    });

    it('keeps the latest Run of a commit in each environment, so a viewer of one environment still sees it', async () => {
        const o = org();
        // Commit a ran in env-1, then again later in env-2 (which a scoped viewer may not read).
        await writer().upsert(randomUUID(), run(o, { prNumber: 1, headSha: 'a'.repeat(40), requestedAt: at(1), environmentId: 'env-1' }));
        await writer().upsert(randomUUID(), run(o, { prNumber: 1, headSha: 'a'.repeat(40), requestedAt: at(2), environmentId: 'env-2' }));
        const got = await new PgPullRequestRunsReader(db).listForPullRequests({ organizationId: o, pullRequests: [{ repositoryId: 'repo-1', prNumber: 1 }], perPullRequest: 3 });
        expect(got.map((r) => [r.environmentId, r.requestedAt])).toEqual([['env-2', at(2)], ['env-1', at(1)]]);
    });

    it('a list of Run summaries answers what the list does, with only the report fields it names', async () => {
        const o = org();
        const probe = { probeId: 'p1', entryPoint: 'GET /orders', verdict: 'regression' };
        await writer().upsert(randomUUID(), run(o, { prNumber: 1, requestedAt: at(1), prTitle: 'Fix orders', cellOwner: 'kodus', findings: [probe as never], probes: [probe as never] }));
        await writer().upsert(randomUUID(), run(o, { prNumber: 2, requestedAt: at(2), environmentId: 'env-other' }));
        await writer().upsert(randomUUID(), run(org(), { prNumber: 1, requestedAt: at(3) }));
        const projection = new ReadOnlyRunProjectionStore(db);
        const whole = await projection.list({ organizationId: o, limit: 10 });
        const summaries = await projection.listSummaries({ organizationId: o, limit: 10 }, ['prTitle', 'cellOwner', 'absent']);
        expect(summaries.map((r) => r.runId)).toEqual(whole.map((r) => r.runId));
        expect(summaries[1]).toEqual({ ...pick(whole[1]), prTitle: 'Fix orders', cellOwner: 'kodus' });
        expect(summaries[1]).not.toHaveProperty('findings');
        expect(summaries[1]).not.toHaveProperty('absent');
        expect(summaries[0]).toEqual(pick(whole[0]));
        // One Run, as the access check reads it: its columns only, and nothing of another org.
        expect(await projection.getSummary(whole[1].runId, { organizationId: o }, [])).toEqual(pick(whole[1]));
        expect(await projection.getSummary(whole[1].runId, { organizationId: org() }, [])).toBeNull();
        // The filters are the list's.
        expect((await projection.listSummaries({ organizationId: o, environmentId: 'env-other', limit: 10 }, [])).map((r) => r.prNumber)).toEqual([2]);
        expect((await projection.listSummaries({ organizationId: o, repositoryIds: [], limit: 10 }, []))).toEqual([]);
        expect((await projection.listSummaries({ organizationId: o, requestedSince: at(2), limit: 10 }, [])).map((r) => r.prNumber)).toEqual([2]);
    });

    it('can never write the Runtime database: the role has no write grant, and every read runs read-only', async () => {
        const o = org();
        const runId = randomUUID();
        await writer().upsert(runId, run(o, { requestedAt: at(1) }));

        const role = new Pool({ connectionString: readerUrl, max: 1 });
        try {
            for (const sql of [
                `UPDATE runtime.runtime_runs SET state = 'errored' WHERE run_id = '${runId}'`,
                `DELETE FROM runtime.runtime_lessons`,
                `INSERT INTO runtime.runtime_environment_setups (environment_id, organization_id, repository_id, setup_key, state, requested_at, updated_at) VALUES ('e', 'o', 'r', 'k', 'active', now(), now())`,
                `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, side, state, lease_expires_at, hard_expires_at) VALUES ('c', 'c', 'o', 'base', 'bound', now(), now())`,
            ]) {
                await expect(role.query(sql)).rejects.toMatchObject({ code: '42501' });
            }
        } finally {
            await role.end();
        }
        // Even a write the role were granted would be refused inside the API's read-only transactions.
        await expect(db.query(`UPDATE runtime.runtime_runs SET state = 'errored' WHERE run_id = $1`, [runId])).rejects.toMatchObject({ code: '25006' });
        expect((await writer().get(runId))?.state).toBe('no_regressions');
    });

    it("lists an org's registration tokens the runtime-worker recorded and revoked, by hash only", async () => {
        const o = org();
        const commands = new PgCommandStore(owner);
        const hash = (c: string) => c.repeat(64);
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        await commands.recordCellToken({ tokenHash: hash('a'), organizationId: o, topology: 'self_hosted', expiresAt, issuedBy: 'u-1' });
        await commands.recordCellToken({ tokenHash: hash('b'), organizationId: o, topology: 'hybrid', expiresAt, issuedBy: 'u-1' });
        await commands.recordCellToken({ tokenHash: hash('c'), organizationId: org(), topology: 'hybrid', expiresAt, issuedBy: 'u-2' });
        expect(await commands.revokeCellToken({ tokenHash: hash('b'), organizationId: o, revokedAt: new Date().toISOString(), revokedBy: 'u-1' })).toBe(true);

        const reader = new PgRuntimeCellTokenReader(db);
        {
            const listed = await reader.listByOrganization(o, new Date(Date.now() - 3_600_000));
            expect(listed.map((t) => [t.tokenHash, t.topology, !!t.revokedAt]).sort()).toEqual([
                [hash('a'), 'self_hosted', false],
                [hash('b'), 'hybrid', true],
            ]);
            expect(await reader.get(hash('c'))).toMatchObject({ tokenHash: hash('c') });
            // The reader is granted those columns only, and never a write.
            const role = new Pool({ connectionString: readerUrl, max: 1 });
            try {
                await expect(role.query('SELECT revoked_by FROM runtime.runtime_cell_tokens')).rejects.toMatchObject({ code: '42501' });
                await expect(role.query(`UPDATE runtime.runtime_cell_tokens SET revoked_at = now()`)).rejects.toMatchObject({ code: '42501' });
            } finally {
                await role.end();
            }
        }
    });

    it("Settings → Outbound access reads the org's egress switch, who may add and the audit the runtime-worker wrote (v32)", async () => {
        const o = org();
        const commands = new PgCommandStore(owner);
        await commands.recordEgressSettings({ organizationId: o, recommendedEnabled: false, whoMayAdd: 'owners_and_repo_admins', updatedBy: 'u-1', updatedAt: at(1) });
        await commands.recordEgressAudit({ key: `k-${randomUUID()}`, organizationId: o, environmentId: 'env-1', host: 'cdn.sheetjs.com', action: 'approve', mode: 'inspected', pathPrefixes: ['/'], actor: 'u-1', source: 'blocker', at: at(2) });
        const reader = new PgRuntimeEgressReader(db);
        expect(await reader.settings(o)).toMatchObject({ recommendedEnabled: false, whoMayAdd: 'owners_and_repo_admins', updatedBy: 'u-1' });
        expect(await reader.audit(o)).toEqual([expect.objectContaining({ action: 'approve', environmentId: 'env-1', host: 'cdn.sheetjs.com', mode: 'inspected', actor: 'u-1' })]);
    });

    it('a bounded read is cancelled by the server once its deadline passes', async () => {
        await expect(db.query('SELECT pg_sleep(5)', [], { timeoutMs: 100 })).rejects.toMatchObject({ code: '57014' });
    });

    it('every reader shares one bounded pool, and shutdown closes all of its connections', async () => {
        const shared = new RuntimeReadDb(readerUrl);
        const readerConnections = async () =>
            Number(
                (
                    await owner.query(
                        `SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'kodus_runtime_reader' AND datname = current_database() AND pid <> pg_backend_pid()`,
                    )
                ).rows[0].n,
            );
        const before = await readerConnections();
        const o = org();
        const slow = Array.from({ length: RUNTIME_READ_POOL_MAX * 2 }, () => shared.query('SELECT pg_sleep(0.3)', []));
        const reads = [
            new PgRuntimeCellTokenReader(shared).listByOrganization(o, new Date(0)),
            new PgRuntimeEgressReader(shared).settings(o),
            new PgRuntimeEgressReader(shared).audit(o),
            new ReadOnlyRunProjectionStore(shared).get(randomUUID()),
        ];
        await new Promise((r) => setTimeout(r, 150));
        const during = (await readerConnections()) - before;
        await Promise.all([...slow, ...reads]);
        expect(during).toBeGreaterThan(0);
        expect(during).toBeLessThanOrEqual(RUNTIME_READ_POOL_MAX);

        await shared.onModuleDestroy();
        let after = await readerConnections();
        for (let i = 0; i < 20 && after > before; i++) {
            await new Promise((r) => setTimeout(r, 50));
            after = await readerConnections();
        }
        expect(after).toBeLessThanOrEqual(before);
    });

    it('reports never hold the connections the screens read on (P5)', async () => {
        const db2 = new RuntimeReadDb(readerUrl);
        try {
            // Twelve 1 s reports, the Speed card and usage reports of many owners at once.
            const reports = Array.from({ length: 12 }, () => db2.reports.query('SELECT pg_sleep(1)', []));
            await new Promise((r) => setTimeout(r, 100));
            const started = Date.now();
            // Every screen connection is free: ten reads at once answer without waiting for any report.
            await Promise.all(Array.from({ length: RUNTIME_READ_POOL_MAX }, () => db2.query('SELECT 1', [])));
            const waited = Date.now() - started;
            await Promise.all(reports);
            // On one shared pool of 10, these reads waited for the reports: about 1 s.
            expect(waited).toBeLessThan(500);
        } finally {
            await db2.onModuleDestroy();
        }
    });
});
