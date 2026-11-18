import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { Pool } from 'pg';

import type { RuntimeRunProjection } from '@libs/runtime/run';
import { PgEnvironmentSetupStore } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { PgRunProjectionStore } from '@libs/runtime/run/adapters/pg-run-projection.store';
import { PgSql } from '@libs/runtime/run/adapters/pg-sql';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { RuntimeRunCostService } from '../application/run-cost.service';
import { GetRuntimeUsageReportUseCase } from '../application/use-cases/usage-report.use-case';
import { PgRuntimeUsageReportReader } from '../infrastructure/pg-runtime-usage-report.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';
import { InMemoryLlmSpend, spendRow } from './fixtures';

// The usage report as the API reads it: a role with scripts/runtime/runtime-reader-grants.sql
// only, inside BEGIN READ ONLY (RuntimeReadDb), over a month the Runtime's stores wrote.
// Opt-in: RUNTIME_IT_DATABASE_URL (a superuser on a disposable server, kr-it-pg locally).
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'usage_report');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const ROLE = `usage_reader_${randomBytes(6).toString('hex')}`;
const PASSWORD = randomBytes(24).toString('hex');
// The grants of kodus_runtime_reader, given to a role of this run's own.
const GRANTS = fs.readFileSync(path.join(__dirname, '../../../../scripts/runtime/runtime-reader-grants.sql'), 'utf8').replace(/kodus_runtime_reader/g, ROLE);

const ORG = `org-${randomUUID()}`;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const at = (day: number, min = 0) => new Date(Date.UTC(2026, 10, day, 10, min));
const ec = (d: Date) => d.toISOString();

(skip ? describe.skip : describe)('the usage report reads a month of the Runtime Postgres with the read-only role (integration)', () => {
    let owner: Pool;
    let db: RuntimeReadDb;
    let usage: GetRuntimeUsageReportUseCase;

    const claim = (c: {
        id: string;
        runId?: string | null;
        environmentId?: string | null;
        consumer: string;
        side: string;
        created: Date;
        heldMin: number;
        mb?: number | null;
        cpus?: number | null;
        start?: 'cold' | 'pool' | 'bake';
        org?: string;
    }) =>
        owner.query(
            `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, environment_id, run_id, side, state, lease_expires_at, hard_expires_at,
                                                 consumer, created_at, admitted_at, ready_at, released_at, state_changed_at, driver,
                                                 memory_mb_boot, memory_mb_ready, memory_allocatable_mb, cpus, start_source)
             VALUES ($1, 'cell-dev-1', $2, $3, $4, $5, 'released', $6, $6, $7, $6, $6, $6, $8, $8, 'docker-gvisor', $9, $9, 14745, $10, $11)`,
            [c.id, c.org ?? ORG, c.environmentId ?? null, c.runId ?? null, c.side, c.created, c.consumer, new Date(c.created.getTime() + c.heldMin * 60_000), c.mb === undefined ? 2_048 : c.mb, c.cpus ?? null, c.start ?? null],
        );
    const sandboxOp = (op: { at: Date; outcome: 'ok' | 'refused' | 'failed'; ms: number; org?: string }) =>
        owner.query(
            `INSERT INTO runtime.runtime_sandbox_audit (org_id, claim_id, cell_id, step_id, op, outcome, duration_ms, at)
             VALUES ($1, 'sandbox-1', 'cell-dev-1', $2, 'exec', $3, $4, $5)`,
            [op.org ?? ORG, randomUUID(), op.outcome, op.ms, op.at],
        );

    beforeAll(async () => {
        await database.create();
        owner = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(owner);
        await owner.query(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${PASSWORD}'`);
        await owner.query(`GRANT CONNECT ON DATABASE "${new URL(database.url).pathname.slice(1)}" TO "${ROLE}"`);
        await owner.query(GRANTS);
        const u = new URL(database.url);
        u.username = ROLE;
        u.password = PASSWORD;
        db = new RuntimeReadDb(u.toString());

        // The month: two Runs of repo-1 (one in env-1), one of repo-2; one Run of last month and one of another org.
        const runs = new PgRunProjectionStore(new PgSql(() => owner));
        const run = (runId: string, patch: Partial<RuntimeRunProjection>) =>
            runs.upsert(runId, { organizationId: ORG, teamId: 't', repositoryId: 'repo-1', repositoryName: 'acme/shop', prNumber: 7, headSha: 'a'.repeat(40), environmentId: 'env-1', imageId: 'i', attempt: 1, state: 'no_regressions', trigger: 'pull_request', ...patch });
        await run('run-a', { requestedAt: ec(at(3)), bootingAt: ec(at(3, 1)), finishedAt: ec(at(3, 13)), bootMs: 90_000, bootTiming: { pr: { prepareMs: 9_000, phases: [{ name: 'compose up', ms: 40_000 }] } } as never });
        await run('run-b', { requestedAt: ec(at(4)), finishedAt: ec(at(4, 30)), environmentId: 'env-2' });
        await run('run-c', { requestedAt: ec(at(5)), finishedAt: ec(at(5, 20)), repositoryId: 'repo-2', environmentId: 'env-3' });
        await run('run-last-month', { requestedAt: ec(new Date(Date.UTC(2026, 9, 31, 23, 50))), finishedAt: ec(at(1, 0)) });
        await run('run-other-org', { organizationId: `org-${randomUUID()}`, requestedAt: ec(at(6)) });
        const setups = new PgEnvironmentSetupStore(new PgSql(() => owner));
        await setups.save({ environmentId: 'env-1', organizationId: ORG, repositoryId: 'repo-1', key: 'k1', state: 'active', steps: [], blockers: [], requestedAt: ec(at(2)), updatedAt: ec(at(2)) } as never);

        await claim({ id: 'a-base', runId: 'run-a', environmentId: 'env-1', consumer: 'runtime', side: 'base', created: at(3, 1), heldMin: 12, cpus: 2, start: 'bake' });
        await claim({ id: 'a-pr', runId: 'run-a', environmentId: 'env-1', consumer: 'runtime', side: 'pr', created: at(3, 1), heldMin: 12, cpus: 2, start: 'pool' });
        await claim({ id: 'b-pr', runId: 'run-b', environmentId: 'env-2', consumer: 'runtime', side: 'pr', created: at(4, 1), heldMin: 10, mb: null });
        await claim({ id: 'c-pr', runId: 'run-c', environmentId: 'env-3', consumer: 'runtime', side: 'pr', created: at(5, 1), heldMin: 10 });
        // Last month's Run made its claim on the first of this month: it belongs to last month's report.
        await claim({ id: 'last-pr', runId: 'run-last-month', environmentId: 'env-1', consumer: 'runtime', side: 'pr', created: at(1, 0), heldMin: 10 });
        await claim({ id: 'setup-1', environmentId: 'env-1', consumer: 'setup', side: 'setup', created: at(2), heldMin: 15 });
        await claim({ id: 'sandbox-1', environmentId: 'sandbox', consumer: 'sandbox', side: 'pr', created: at(7), heldMin: 5, cpus: 4 });
        await claim({ id: 'other-org', consumer: 'sandbox', side: 'pr', created: at(7), heldMin: 99, org: `org-${randomUUID()}` });
        // The sandbox's operations: three this month (one refused), one of last month, one of another org.
        await sandboxOp({ at: at(7, 1), outcome: 'ok', ms: 1_500 });
        await sandboxOp({ at: at(7, 2), outcome: 'refused', ms: 0 });
        await sandboxOp({ at: at(7, 3), outcome: 'ok', ms: 500 });
        await sandboxOp({ at: new Date(Date.UTC(2026, 9, 31, 23, 59)), outcome: 'ok', ms: 9_000 });
        await sandboxOp({ at: at(7, 4), outcome: 'failed', ms: 7_000, org: `org-${randomUUID()}` });

        const spend = new InMemoryLlmSpend([
            { ...spendRow({ runId: 'run-a', usd: 0.4 }), organizationId: ORG, at: at(3, 5) },
            { ...spendRow({ runId: 'setup-scope', agent: 'recipe_author', environmentId: 'env-1', usd: 1 }), organizationId: ORG, at: at(2, 5) },
        ]);
        const config = { cellPrices: { 'cell-dev-1': { instanceType: 't4g.xlarge', usdPerHour: 0.1344, region: 'us-east-2' } }, machineUnitPrices: { usdPerGbMinute: 0.001, usdPerVcpuMinute: 0 } };
        const clock = () => NOW;
        usage = new GetRuntimeUsageReportUseCase(new PgRuntimeUsageReportReader(db), new RuntimeRunCostService(clock, spend, undefined, config), config, clock, spend);
    });

    afterAll(async () => {
        await db?.onModuleDestroy();
        await owner?.end();
        await database.drop();
    });

    const owned = { organization: { uuid: ORG } } as never;

    it("aggregates one org's month: its Runs, the Runs' claims wherever they fell, setups and sandbox sessions", async () => {
        const r = await usage.execute({ user: owned, query: { month: '2026-11' } });

        expect(r.counts).toEqual({
            runs: 3, runsListed: 3, setups: 1, sandboxSessions: 1,
            sandboxOperations: { total: 3, refused: 1, failed: 0, durationMs: 2_000, partial: false },
            claimsTruncated: false,
        });
        expect(r.runs.map((x) => x.runId)).toEqual(['run-c', 'run-b', 'run-a']);
        expect(r.wallTime.runs).toMatchObject({ count: 3, p50Minutes: 20, totalMinutes: 63 });
        // a-base + a-pr + c-pr + setup-1 + sandbox-1 at 2 GB; b-pr recorded no memory.
        expect(r.machine.total).toMatchObject({ claims: 6, gbMinutes: 2 * (12 + 12 + 10 + 15 + 5), unmeasured: { memory: 1, cpu: 3 }, vcpuMinutes: 2 * 12 * 2 + 4 * 5 });
        expect(r.machine.total.unitUsd).toBe(0.108);
        const a = r.runs.find((x) => x.runId === 'run-a')!;
        // a-base booted the bake, a-pr took a pool machine: the Run is as warm as its coldest.
        expect(r.runs.map((x) => [x.runId, x.start])).toEqual([['run-c', null], ['run-b', null], ['run-a', 'bake']]);
        expect(a).toMatchObject({ wallMinutes: 13, bootMs: 90_000, bootPhases: { pr: [{ name: 'compose up', ms: 40_000 }] }, machine: { gbMinutes: 48, claims: 2 }, llm: { usd: 0.4 } });
        expect(r.llm.byAgent.map((x) => [x.agent, x.usd])).toEqual([
            ['recipe_author', 1],
            ['run_agent', 0.4],
        ]);
    });

    it('filters by repository and environment in the query', async () => {
        const repo = await usage.execute({ user: owned, query: { month: '2026-11', repositoryId: 'repo-1' } });
        expect(repo.runs.map((x) => x.runId).sort()).toEqual(['run-a', 'run-b']);
        expect(repo.counts).toMatchObject({ runs: 2, setups: 1, sandboxSessions: null });

        const env = await usage.execute({ user: owned, query: { month: '2026-11', environmentId: 'env-1' } });
        expect(env.runs.map((x) => x.runId)).toEqual(['run-a']);
        expect(env.machine.byConsumer.map((g) => [g.consumer, g.side, g.claims])).toEqual(
            expect.arrayContaining([
                ['runtime', 'base', 1],
                ['runtime', 'pr', 1],
                ['setup', 'setup', 1],
            ]),
        );
        expect(env.llm.total?.usd).toBe(1.4);
    });

    it('exports the seeded month as CSV, one line per Run', async () => {
        const { filename, body } = await usage.csv({ user: owned, query: { month: '2026-11' } });
        expect(filename).toBe('kody-runtime-usage-2026-11.csv');
        const lines = body.trimEnd().split('\r\n');
        expect(lines).toHaveLength(4);
        expect(lines[3].startsWith('run-a,2026-11-03T10:00:00.000Z,2026-11-03T10:13:00.000Z,acme/shop,repo-1,env-1,7,pull_request,no_regressions,')).toBe(true);
    });

    it("reads only an org's preview claims of the month for the preview minutes, and says when a limit cut them", async () => {
        const org = `org-${randomUUID()}`;
        await claim({ id: `p1-${org}`, consumer: 'preview', side: 'pr', created: at(8), heldMin: 20, org });
        await claim({ id: `p2-${org}`, consumer: 'preview', side: 'base', created: at(9), heldMin: 5, org });
        await claim({ id: `s-${org}`, consumer: 'sandbox', side: 'pr', created: at(8), heldMin: 50, org });
        await claim({ id: `old-${org}`, consumer: 'preview', side: 'pr', created: new Date(Date.UTC(2026, 9, 30)), heldMin: 50, org });
        const reader = new PgRuntimeUsageReportReader(db);
        const month = { start: new Date(Date.UTC(2026, 10, 1)), end: new Date(Date.UTC(2026, 11, 1)) };
        const all = await reader.previewClaimsOfMonth(org, month, 10);
        expect([all.claims.map((c) => c.claimId), all.truncated]).toEqual([[`p1-${org}`, `p2-${org}`], false]);
        expect(all.claims.every((c) => c.consumer === 'preview')).toBe(true);
        expect((await reader.previewClaimsOfMonth(org, month, 1)).truncated).toBe(true);
    });

    it('a write through the reader is refused by the server', async () => {
        await expect(db.query(`DELETE FROM runtime.runtime_claims`, [])).rejects.toThrow(/read-only transaction|permission denied/);
    });
});
