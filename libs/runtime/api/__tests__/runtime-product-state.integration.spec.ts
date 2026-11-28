import { createHash, randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { MoveRuntimeProductStoresToPostgres2026111200000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111200000000-MoveRuntimeProductStoresToPostgres';
import { CreateRuntimeReconciledHeads2026111500000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111500000000-CreateRuntimeReconciledHeads';
import { CreateRuntimePullRequestChecks2026111800000020 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111800000020-CreateRuntimePullRequestChecks';
import { IndexRuntimePullRequestChecksUpdatedAt2026111800000030 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111800000030-IndexRuntimePullRequestChecksUpdatedAt';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';

import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { planLlmCall } from '../domain/budget';
import { LlmBudgetBusyError } from '../domain/ports';
import { sweepRuntimeProductRetention } from '../infrastructure/runtime-product-retention.cron';
import { TypeOrmRuntimeEnvAuditStore } from '../infrastructure/typeorm-env-audit.store';
import { orgDayCounterKey, pullRequestCounterKey, runCounterKey, TypeOrmRuntimeLlmBudgetStore } from '../infrastructure/typeorm-llm-budget.store';
import { TypeOrmModelTurnReceipts } from '../infrastructure/typeorm-model-turn-receipts.store';
import { TypeOrmRecipeAuthorReceipts, TypeOrmSetupCallCounter } from '../infrastructure/typeorm-setup-calls.store';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';

// The Runtime's product-side stores (product Postgres, the migration
// MoveRuntimeProductStoresToPostgres) against a real Postgres: what only the
// database guarantees, the atomic counters under concurrency, the unique
// claims, what survives a new connection and the retention deletes. Opt-in:
// RUNTIME_IT_DATABASE_URL, in a leased database (advisory locks are
// database-wide) and a schema of its own, made by the migration itself.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'runtime_product_state');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const schema = `runtime_state_it_${process.pid}`;

(skip ? describe.skip : describe)('Runtime product state in the product Postgres (integration, real Postgres)', () => {
    let admin: Pool;
    const sources: DataSource[] = [];
    let sql: TypeOrmSql;

    /** A DataSource as one API instance holds it: a restart is a new one. */
    const instance = async () => {
        const source = new DataSource({ type: 'postgres', url: database.url, entities: [], synchronize: false, extra: { options: `-c search_path=${schema}`, max: 20 } });
        await source.initialize();
        sources.push(source);
        return new TypeOrmSql(source);
    };

    beforeAll(async () => {
        await database.create();
        admin = new Pool({ connectionString: database.url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        sql = await instance();
        const source = sources[0];
        const runner = source.createQueryRunner();
        try {
            await new MoveRuntimeProductStoresToPostgres2026111200000000().up(runner);
            await new CreateRuntimeReconciledHeads2026111500000000().up(runner);
            await new CreateRuntimePullRequestChecks2026111800000020().up(runner);
            await new IndexRuntimePullRequestChecksUpdatedAt2026111800000030().up(runner);
        } finally {
            await runner.release();
        }
    });
    afterAll(async () => {
        for (const s of sources) await s.destroy();
        await admin?.end();
        await database.drop();
    });

    const NOW = new Date();
    const later = (ms: number) => new Date(NOW.getTime() + ms);

    describe('LLM budget (S-47)', () => {
        const DAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
        const limits = { perRun: 1_000, perPullRequest: 10_000, perOrgPerDay: 100_000 };
        const plan = (spend: Parameters<typeof planLlmCall>[0]) => {
            const p = planLlmCall(spend, limits, { inputTokens: 10, requestedOutputTokens: 200 });
            return p.allowed ? p.reserve : null;
        };
        let org: string;
        const usage = (runId: string, prNumber = 7) => ({ runId, organizationId: org, repositoryId: '42', prNumber, task: 'runtime.plan', at: NOW });
        const counter = async (key: string) => Number((await sql.query('SELECT tokens FROM runtime_llm_budget WHERE key = $1', [key])).rows[0]?.tokens ?? NaN);
        const store = () => new TypeOrmRuntimeLlmBudgetStore(sql);
        beforeEach(() => {
            org = `org-${randomUUID()}`;
        });

        it('reserves on all three scopes, settles to the real usage, and settles once', async () => {
            const runId = randomUUID();
            const res = await store().reserve({ usage: usage(runId), orgDayStart: DAY, decide: plan });
            expect(res?.tokens).toBe(210);
            expect(await store().totalForRun(runId)).toBe(210);
            expect(await counter(pullRequestCounterKey(usage(runId)))).toBe(210);
            expect(await counter(orgDayCounterKey(org, DAY))).toBe(210);

            await store().settle(res!.reservationId, { inputTokens: 40, outputTokens: 60 });
            await store().settle(res!.reservationId, { inputTokens: 40, outputTokens: 60 });
            expect(await store().totalForRun(runId)).toBe(100);
            expect(await counter(orgDayCounterKey(org, DAY))).toBe(100);
            expect((await sql.query('SELECT count(*)::int AS n FROM runtime_llm_reservations WHERE run_id = $1', [runId])).rows[0].n).toBe(0);
        });

        it('gives back a cancelled reservation, and decides on what the scopes already spent', async () => {
            const runId = randomUUID();
            const first = await store().reserve({ usage: usage(runId), orgDayStart: DAY, decide: () => 100 });
            await store().settle(first!.reservationId, { inputTokens: 40, outputTokens: 60 });
            const res = await store().reserve({ usage: usage(runId), orgDayStart: DAY, decide: () => 50 });
            expect(await store().totalForRun(runId)).toBe(150);
            await store().cancel(res!.reservationId);
            expect(await store().totalForRun(runId)).toBe(100);

            const seen: unknown[] = [];
            const other = randomUUID();
            expect(await store().reserve({ usage: usage(other), orgDayStart: DAY, decide: (spend) => (seen.push(spend), null) })).toBeNull();
            // Another Run of the same PR, same org and day: only the Run scope is new. A refusal takes nothing.
            expect(seen).toEqual([{ run: 0, pullRequest: 100, orgToday: 100 }]);
            expect(await store().totalForRun(other)).toBe(0);
        });

        it('lets concurrent calls of one org, across API instances, never pass the limit together', async () => {
            const instances = [sql, await instance(), await instance()];
            const runId = randomUUID();
            const results = await Promise.all(
                Array.from({ length: 12 }, (_, i) => new TypeOrmRuntimeLlmBudgetStore(instances[i % 3]).reserve({ usage: usage(runId, 8), orgDayStart: DAY, decide: plan })),
            );
            const granted = results.filter(Boolean);
            expect(results.some((r) => r === null)).toBe(true);
            const total = granted.reduce((n, r) => n + r!.tokens, 0);
            expect(total).toBeLessThanOrEqual(1_000);
            // The counters hold exactly what was granted.
            expect(await store().totalForRun(runId)).toBe(total);
            expect(await counter(pullRequestCounterKey(usage(runId, 8)))).toBe(total);
        });

        it('refuses as busy, with nothing taken, a call that waits too long for another call of its org', async () => {
            const holder = await admin.connect();
            const runId = randomUUID();
            try {
                await holder.query('BEGIN');
                await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kody-runtime/llm-budget/${org}`]);
                const err = await new TypeOrmRuntimeLlmBudgetStore(sql, 200).reserve({ usage: usage(runId), orgDayStart: DAY, decide: () => 5 }).catch((e) => e);
                expect(err).toBeInstanceOf(LlmBudgetBusyError);
            } finally {
                await holder.query('ROLLBACK');
                holder.release();
            }
            expect(await store().totalForRun(runId)).toBe(0);
            expect((await sql.query('SELECT count(*)::int AS n FROM runtime_llm_reservations WHERE run_id = $1', [runId])).rows[0].n).toBe(0);
            expect(await counter(orgDayCounterKey(org, DAY))).toBeNaN();
            expect(await counter(runCounterKey(runId))).toBeNaN();
        });
    });

    describe("a setup's calls asked again", () => {
        const claim = (key: string, owner: string, patch: Partial<Parameters<TypeOrmRecipeAuthorReceipts['claim']>[0]> = {}, on = sql) =>
            new TypeOrmRecipeAuthorReceipts(on).claim({ key, fingerprint: 'f1', owner, now: NOW, leaseUntil: later(60_000), expiresAt: later(3_600_000), ...patch });

        it('of sixteen instances asking the same attempt at once, exactly one runs Kody; the others see it running', async () => {
            const key = randomUUID();
            const others = [sql, await instance()];
            const results = await Promise.all(Array.from({ length: 16 }, (_, i) => claim(key, `owner-${i}`, {}, others[i % 2])));
            expect(results.filter((r) => r.state === 'fresh')).toHaveLength(1);
            expect(results.filter((r) => r.state === 'running')).toHaveLength(15);
        });

        it("an attempt's answer is read back by a restarted API, and a later call can never replace it", async () => {
            const key = randomUUID();
            const store = new TypeOrmRecipeAuthorReceipts(sql);
            await claim(key, 'a');
            await store.complete(key, 'a', { status: 200, body: { status: 'no_recipe', reason: 'r', usage: { inputTokens: 1, outputTokens: 1 } } });
            await store.complete(key, 'a', { status: 502, body: { code: 'llm_unavailable' } });
            await store.release(key, 'a');
            const restarted = await instance();
            expect(await claim(key, 'b', { now: later(3_000_000), leaseUntil: later(3_060_000) }, restarted)).toEqual({
                state: 'done',
                outcome: { status: 200, body: { status: 'no_recipe', reason: 'r', usage: { inputTokens: 1, outputTokens: 1 } } },
            });
        });

        it('a run whose lease lapsed is taken over once, with the budget it reserved; one within its lease, or settled, is not reused', async () => {
            const key = randomUUID();
            const store = new TypeOrmRecipeAuthorReceipts(sql);
            await claim(key, 'dead');
            await store.reserved(key, 'dead', { reservationId: 'res-1', tokens: 400_000 });
            expect(await claim(key, 'early', { now: later(59_000) })).toEqual({ state: 'running' });
            const late = await Promise.all(['x', 'y', 'z'].map((o) => claim(key, o, { now: later(61_000), leaseUntil: later(121_000) })));
            expect(late.filter((r) => r.state === 'taken_over')).toEqual([{ state: 'taken_over', reservation: { reservationId: 'res-1', tokens: 400_000 } }]);
            // The dead owner can no longer answer nor give back the attempt.
            await store.complete(key, 'dead', { status: 200, body: 'stale' });
            await store.release(key, 'dead');
            const winner = ['x', 'y', 'z'][late.findIndex((r) => r.state === 'taken_over')];
            await store.settled(key, winner);
            expect(await claim(key, 'next', { now: later(200_000), leaseUntil: later(260_000) })).toEqual({ state: 'taken_over' });
        });

        it('the same attempt asked with another body is a conflict; a call that spent nothing gives it back to the next', async () => {
            const key = randomUUID();
            const store = new TypeOrmRecipeAuthorReceipts(sql);
            await claim(key, 'a');
            expect(await claim(key, 'b', { fingerprint: 'f2' })).toEqual({ state: 'conflict' });
            await store.release(key, 'b');
            expect(await claim(key, 'c')).toEqual({ state: 'running' });
            await store.release(key, 'a');
            expect(await claim(key, 'd')).toEqual({ state: 'fresh' });
        });

        it('of thirty concurrent calls of one setup, across instances, exactly the max are counted', async () => {
            const instances = [sql, await instance()];
            const key = `setup-${randomUUID()}/repair`;
            const results = await Promise.all(Array.from({ length: 30 }, (_, i) => new TypeOrmSetupCallCounter(instances[i % 2]).take(key, 7, later(3_600_000))));
            expect(results.filter(Boolean)).toHaveLength(7);
            expect(await new TypeOrmSetupCallCounter(sql).take(`setup-${randomUUID()}/repair`, 7, later(3_600_000))).toBe(true);
        });

        it('counts a key whose parts are joined with NUL, as setup-repo-tokens builds it', async () => {
            const key = `setup-repo-tokens\0${randomUUID()}\0repair`;
            const counter = new TypeOrmSetupCallCounter(sql);
            expect(await counter.take(key, 2, later(3_600_000))).toBe(true);
            expect(await counter.take(key, 2, later(3_600_000))).toBe(true);
            expect(await counter.take(key, 2, later(3_600_000))).toBe(false);
        });
    });

    describe('model turn receipts', () => {
        const digest = (text: string) => createHash('sha256').update(text).digest('hex');
        const response = (): ModelTurnResponse => ({
            v: 1,
            scope: { runId: randomUUID(), attempt: 1, turnId: randomUUID() },
            generation: { content: [{ type: 'text', text: 'bounded synthetic fixture' }], finishReason: { unified: 'stop' }, usage: { reported: true, inputTokens: { total: 10 }, outputTokens: { total: 2 } }, warnings: [] },
            budget: { remainingTokens: 88, usageBasis: 'provider_reported' },
        });
        const expiry = () => later(30 * 86_400_000);

        it('grants exactly one fresh turn across 16 concurrent instances and keeps the completed response for a restarted API', async () => {
            const key = digest(randomUUID());
            const fingerprint = digest('closed validated request');
            const instances = [sql, await instance()];
            const results = await Promise.all(Array.from({ length: 16 }, (_, i) => new TypeOrmModelTurnReceipts(instances[i % 2]).claim(key, fingerprint, expiry())));
            expect(results.filter((r) => r.fresh)).toHaveLength(1);
            const answer = response();
            await new TypeOrmModelTurnReceipts(sql).complete(key, fingerprint, answer);
            expect(await new TypeOrmModelTurnReceipts(await instance()).claim(key, fingerprint, expiry())).toEqual({ fresh: false, fingerprint, response: answer });
        });

        it('keeps a pending turn non-fresh, never replaces a fingerprint or a completed response, and never stores an oversized one', async () => {
            const store = new TypeOrmModelTurnReceipts(sql);
            const key = digest(randomUUID());
            const fingerprint = digest('original request');
            expect(await store.claim(key, fingerprint, expiry())).toEqual({ fresh: true });
            expect(await store.claim(key, digest('changed request'), expiry())).toEqual({ fresh: false, fingerprint });
            await expect(store.complete(key, digest('changed request'), response())).rejects.toThrow('conflict');
            const big = response();
            big.generation.content = [{ type: 'text', text: 'x'.repeat(1_000_001) }];
            await expect(store.complete(key, fingerprint, big)).rejects.toThrow('too large');
            expect(await store.claim(key, fingerprint, expiry())).toEqual({ fresh: false, fingerprint });
            const answer = response();
            await store.complete(key, fingerprint, answer);
            await expect(store.complete(key, fingerprint, response())).rejects.toThrow('conflict');
            expect(await store.claim(key, fingerprint, expiry())).toEqual({ fresh: false, fingerprint, response: answer });
        });
    });

    it("the env_exec quota counts only the org's (or one key's) accepted runs since the window opened, and the audit lists newest first", async () => {
        const store = new TypeOrmRuntimeEnvAuditStore(sql);
        const org = `org-${randomUUID()}`;
        const rec = (min: number, patch: Record<string, unknown> = {}) => ({
            auditId: randomUUID(),
            kind: 'env_exec' as const,
            organizationId: org,
            teamId: 't',
            keyId: 'key-1',
            repositoryId: 'r',
            command: 'npm test',
            at: new Date(Date.UTC(2026, 10, 12, 10, min)).toISOString(),
            outcome: 'accepted' as const,
            ...patch,
        });
        const rows = [rec(1), rec(2, { keyId: 'key-2' }), rec(3, { outcome: 'refused_quota' }), rec(4, { kind: 'env_fix' }), rec(0)];
        for (const r of rows) await store.record(r);
        await store.record(rec(5, { organizationId: `org-${randomUUID()}` }));
        await store.setOutcome(org, rows[0].auditId, 'failed', 'exit 1');

        const since = new Date(Date.UTC(2026, 10, 12, 10, 1)).toISOString();
        expect(await store.countAccepted({ organizationId: org, since })).toBe(1);
        expect(await store.countAccepted({ organizationId: org, keyId: 'key-1', since: rows[4].at })).toBe(1);
        const listed = await store.list({ organizationId: org, kind: 'env_exec', limit: 10 });
        expect(listed.map((r) => r.at)).toEqual([rows[2].at, rows[1].at, rows[0].at, rows[4].at]);
        expect(listed[2]).toEqual({ ...rows[0], outcome: 'failed', reason: 'exit 1' });
        expect((await store.list({ organizationId: org, kind: 'env_exec', limit: 10, before: rows[1].at })).map((r) => r.auditId)).toEqual([rows[0].auditId, rows[4].auditId]);
    });

    it('retention removes the expired receipts, counts, per-day counters and reservations, audit rows past 90 days, reconciled heads and PR check slots past 30 days; the rest stays', async () => {
        const past = new Date(Date.now() - 60_000);
        const future = later(3_600_000);
        const id = () => `retention-${randomUUID()}`;
        const keys = { goneTurn: id(), keptTurn: id(), goneCount: id(), keptCount: id(), goneDay: id(), runCounter: id(), goneAudit: id(), keptAudit: id() };
        await sql.query(`INSERT INTO runtime_model_turn_receipts (key, fingerprint, expires_at) VALUES ($1, 'f', $3), ($2, 'f', $4)`, [keys.goneTurn, keys.keptTurn, past, future]);
        await sql.query(`INSERT INTO runtime_setup_call_counts (key, count, expires_at) VALUES ($1, 1, $3), ($2, 1, $4)`, [keys.goneCount, keys.keptCount, past, future]);
        await sql.query(`INSERT INTO runtime_llm_budget (key, tokens, expires_at) VALUES ($1, 1, $3), ($2, 1, NULL)`, [keys.goneDay, keys.runCounter, past]);
        const audit = (auditId: string, at: Date) =>
            sql.query(`INSERT INTO runtime_env_audit (audit_id, organization_id, team_id, key_id, repository_id, kind, outcome, at) VALUES ($1, 'o', 't', 'k', 'r', 'env_exec', 'accepted', $2)`, [auditId, at]);
        await audit(keys.goneAudit, new Date(Date.now() - 91 * 86_400_000));
        await audit(keys.keptAudit, new Date(Date.now() - 89 * 86_400_000));
        const head = (repositoryId: string, at: Date) =>
            sql.query(
                `INSERT INTO runtime_reconciled_heads (organization_id, repository_id, pr_number, head_sha, state, attempts, claimed_at, updated_at) VALUES ('o', $1, 1, $2, 'decided', 1, $3, $3)`,
                [repositoryId, 'a'.repeat(40), at],
            );
        const heads = { gone: id(), kept: id() };
        await head(heads.gone, new Date(Date.now() - 31 * 86_400_000));
        await head(heads.kept, new Date(Date.now() - 29 * 86_400_000));
        // One row per head and check: kept 30 days, and never while a delivery holds its lease.
        const check = (repositoryId: string, at: Date, leaseUntil: Date | null) =>
            sql.query(
                `INSERT INTO runtime_pr_checks (organization_id, repository_id, head_sha, check_name, check_order, lease_owner, lease_until, updated_at) VALUES ('o', $1, $2, 'Kody Runtime', 1, $3, $4, $5)`,
                [repositoryId, 'b'.repeat(40), leaseUntil ? 'holder' : null, leaseUntil, at],
            );
        const checks = { gone: id(), goneTwo: id(), kept: id(), leased: id() };
        await check(checks.gone, new Date(Date.now() - 31 * 86_400_000), null);
        await check(checks.goneTwo, new Date(Date.now() - 40 * 86_400_000), past);
        await check(checks.kept, new Date(Date.now() - 29 * 86_400_000), null);
        await check(checks.leased, new Date(Date.now() - 31 * 86_400_000), future);

        await sweepRuntimeProductRetention(sql, 1);

        const left = async (table: string, column: string, ids: string[]) =>
            (await sql.query(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ANY($1::text[]) ORDER BY 1`, [ids])).rows.map((r) => r.id);
        expect(await left('runtime_model_turn_receipts', 'key', [keys.goneTurn, keys.keptTurn])).toEqual([keys.keptTurn]);
        expect(await left('runtime_setup_call_counts', 'key', [keys.goneCount, keys.keptCount])).toEqual([keys.keptCount]);
        expect(await left('runtime_llm_budget', 'key', [keys.goneDay, keys.runCounter])).toEqual([keys.runCounter]);
        expect(await left('runtime_env_audit', 'audit_id', [keys.goneAudit, keys.keptAudit])).toEqual([keys.keptAudit]);
        expect(await left('runtime_reconciled_heads', 'repository_id', [heads.gone, heads.kept])).toEqual([heads.kept]);
        expect(await left('runtime_pr_checks', 'repository_id', Object.values(checks))).toEqual([checks.kept, checks.leased].sort());
    });
});
