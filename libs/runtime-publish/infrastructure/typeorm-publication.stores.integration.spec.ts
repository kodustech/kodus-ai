import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { MoveRuntimeProductStoresToPostgres2026111200000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111200000000-MoveRuntimeProductStoresToPostgres';
import { AddRuntimePullRequestCommentEnvironment2026111300000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111300000000-AddRuntimePullRequestCommentEnvironment';
import { TypeOrmSql } from '@libs/runtime/api/infrastructure/typeorm-sql';

import { isolatedDatabase } from '../../../apps/runtime/src/testing/isolated-database';
import { commentOrderOf } from '../application/comment-publisher';
import type { ClaimRequest } from '../domain/runtime-publication';
import { CreateRuntimePullRequestChecks2026111800000020 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111800000020-CreateRuntimePullRequestChecks';
import { TypeOrmCheckSlotStore } from './typeorm-check-slot.store';
import { TypeOrmCommentSlotStore } from './typeorm-comment-slot.store';
import { TypeOrmPublicationReader, TypeOrmPublicationStore } from './typeorm-publication.store';

// What the product worker published for a Run, and the one comment per PR,
// against a real Postgres (product schema from the migration
// MoveRuntimeProductStoresToPostgres): the claims are atomic, so concurrent
// deliveries of the same message publish once. Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'runtime_publications');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const schema = `runtime_publications_it_${process.pid}`;

(skip ? describe.skip : describe)('Runtime publications in the product Postgres (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;
    let store: TypeOrmPublicationStore;
    let slots: TypeOrmCommentSlotStore;
    let reader: TypeOrmPublicationReader;

    beforeAll(async () => {
        await database.create();
        admin = new Pool({ connectionString: database.url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: database.url, entities: [], synchronize: false, extra: { options: `-c search_path=${schema}`, max: 20 } });
        await source.initialize();
        const runner = source.createQueryRunner();
        try {
            await new MoveRuntimeProductStoresToPostgres2026111200000000().up(runner);
            // A slot written before the environment key: it must stay the repository's own after the migration.
            await runner.query(
                `INSERT INTO runtime_pr_comments (organization_id, repository_id, pr_number, team_id, comment, comment_order, updated_at) VALUES ('org-a', 'repo-legacy', 1, 'team-a', '{"id": 5}', 17630000000000, now())`,
            );
            // Twice: the migration is idempotent.
            await new AddRuntimePullRequestCommentEnvironment2026111300000000().up(runner);
            await new AddRuntimePullRequestCommentEnvironment2026111300000000().up(runner);
            await new CreateRuntimePullRequestChecks2026111800000020().up(runner);
            await new CreateRuntimePullRequestChecks2026111800000020().up(runner);
        } finally {
            await runner.release();
        }
        const sql = new TypeOrmSql(source);
        store = new TypeOrmPublicationStore(sql);
        slots = new TypeOrmCommentSlotStore(sql);
        reader = new TypeOrmPublicationReader(sql);
    });
    afterAll(async () => {
        await source?.destroy();
        await admin?.end();
        await database.drop();
    });

    const NOW = new Date('2026-11-12T12:00:00.000Z');
    const plus = (ms: number) => new Date(NOW.getTime() + ms);
    const claim = (patch: Partial<ClaimRequest> = {}): ClaimRequest => {
        const runId = patch.runId ?? randomUUID();
        return { key: `${runId}:1:comment`, runId, attempt: 1, kind: 'comment', organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: 42, headSha: 'a'.repeat(40), ...patch };
    };

    it('a check slot is held by one delivery at a time and keeps the highest order published (V-02)', async () => {
        const checks = new TypeOrmCheckSlotStore(new TypeOrmSql(source));
        const ref = { organizationId: 'org-a', repositoryId: 'repo-1', headSha: 'c'.repeat(40), checkName: 'Kody Runtime' };
        const held = await Promise.all(Array.from({ length: 6 }, (_, i) => checks.acquire(ref, `owner-${i}`, NOW)));
        expect(held.filter(Boolean)).toHaveLength(1);
        const owner = held.find(Boolean)!.leaseOwner!;
        await checks.recordOrder(ref, owner, 200);
        await checks.recordOrder(ref, owner, 100);
        await checks.recordOrder(ref, 'not-the-owner', 900);
        await checks.release(ref, owner);
        expect(await checks.acquire(ref, 'next', NOW)).toMatchObject({ checkOrder: 200, leaseOwner: 'next' });
        // A lease that lapsed is taken over.
        expect(await checks.acquire(ref, 'late', plus(3 * 60_000))).toMatchObject({ leaseOwner: 'late' });
    });

    it('of eight deliveries of one message at once, one publishes; the others are busy, then a duplicate once it is published', async () => {
        const req = claim();
        const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(req, NOW)));
        expect(results.filter((r) => r.state === 'claimed')).toHaveLength(1);
        expect(results.filter((r) => r.state === 'busy')).toHaveLength(7);
        await store.complete(req.key, { status: 'published', comment: { id: 7, noteId: 'n-1' } });
        const again = await store.claim(req, plus(1_000));
        expect(again).toMatchObject({ state: 'duplicate', publication: { status: 'published', comment: { id: 7, noteId: 'n-1' } } });
        expect(again.publication).not.toHaveProperty('leaseUntil');
    });

    it('a failed delivery, or one whose lease lapsed, is taken over with what it kept for the retry; a published comment never is', async () => {
        const req = claim();
        await store.claim(req, NOW);
        await store.release(req.key, 'platform_5xx', { checkRunId: 99 });
        expect(await store.claim(req, plus(1_000))).toMatchObject({ state: 'claimed', publication: { status: 'publishing', reason: 'platform_5xx', checkRunId: 99 } });
        // Its lease runs 5 minutes: a delivery within it is busy, one after takes it over.
        expect((await store.claim(req, plus(60_000))).state).toBe('busy');
        expect((await store.claim(req, plus(6 * 60_000))).state).toBe('claimed');
    });

    it('a published check moves forward only for a later status of its lifecycle, keeping its check run', async () => {
        const runId = randomUUID();
        const check = (rank: number) => claim({ runId, key: `${runId}:1:check`, kind: 'check', checkRank: rank });
        await store.claim(check(1), NOW);
        await store.complete(`${runId}:1:check`, { status: 'published', checkRank: 1, checkRunId: 555 });
        expect((await store.claim(check(1), plus(1_000))).state).toBe('duplicate');
        expect(await store.claim(check(3), plus(2_000))).toMatchObject({ state: 'claimed', publication: { checkRank: 1, checkRunId: 555 } });
        expect(await store.findCheckRunId(`${runId}:1:check`)).toBe(555);
        expect(await store.findCheckRunId(`${runId}:1:comment`)).toBeNull();
    });

    it('a check has its verdict on the PR only once its completed status is published', async () => {
        const runId = randomUUID();
        const key = `${runId}:1:check`;
        const check = (rank: number) => claim({ runId, key, kind: 'check', checkRank: rank });
        expect(await store.hasPublishedVerdict(key)).toBe(false);
        await store.claim(check(2), NOW);
        await store.complete(key, { status: 'published', checkRank: 2, commitStatus: true });
        expect(await store.hasPublishedVerdict(key)).toBe(false);
        await store.claim(check(3), plus(1_000));
        expect(await store.hasPublishedVerdict(key)).toBe(false);
        await store.complete(key, { status: 'published', checkRank: 3, commitStatus: true });
        expect(await store.hasPublishedVerdict(key)).toBe(true);
        expect(await store.hasPublishedVerdict(`${runId}:1:comment`)).toBe(false);
    });

    it('the redrive sweeper finds stale final publications oldest first, takes each once, and a given-up row stays failed', async () => {
        const LATER = '2099-01-01T00:00:00.000Z';
        const finalAt = (min: number) => ({ r: claim({ request: { runId: 'r', marker: min } as never }), at: new Date(Date.UTC(2026, 10, 12, 11, min)) });
        const older = finalAt(0);
        const old = finalAt(1);
        const noRequest = { r: claim(), at: new Date(Date.UTC(2026, 10, 12, 11, 2)) };
        // Their deliveries died: each lease lapses on its own.
        for (const x of [old, older, noRequest]) await store.claim(x.r, x.at);

        const mine = (await store.findStale(LATER, LATER, 50)).filter((p) => [old.r.key, older.r.key, noRequest.r.key].includes(p.key));
        expect(mine.map((p) => p.key)).toEqual([older.r.key, old.r.key]);
        expect(mine[0].request).toEqual({ runId: 'r', marker: 0 });

        const seen = mine[0].updatedAt;
        const taken = await Promise.all([1, 2, 3].map(() => store.reserveRedrive(older.r.key, seen, '2026-11-12T13:00:01.000Z')));
        expect(taken.filter(Boolean)).toHaveLength(1);
        expect(taken.find(Boolean)).toMatchObject({ redrive: { attempts: 1, lastAt: '2026-11-12T13:00:01.000Z' }, updatedAt: '2026-11-12T13:00:01.000Z' });

        await store.giveUp(older.r.key, 'attempts', '2026-11-12T13:00:02.000Z');
        expect(await store.reserveRedrive(older.r.key, '2026-11-12T13:00:02.000Z', '2026-11-12T13:00:03.000Z')).toBeNull();
        expect((await store.findStale(LATER, LATER, 50)).map((p) => p.key)).not.toContain(older.r.key);
        expect(await reader.listForRun('org-a', older.r.runId)).toMatchObject([{ status: 'failed', redrive: { attempts: 1, gaveUpReason: 'attempts' } }]);
    });

    it("the Run page reads one Run's publications of its own org, without the stored request", async () => {
        const runId = randomUUID();
        await store.claim(claim({ runId, request: { secret: 'kept for the redrive only' } as never }), NOW);
        await store.claim(claim({ runId, key: `${runId}:1:check`, kind: 'check', checkRank: 1 }), NOW);
        const rows = await reader.listForRun('org-a', runId);
        expect(rows.map((r) => r.kind).sort()).toEqual(['check', 'comment']);
        expect(rows.some((r) => 'request' in r)).toBe(false);
        expect(await reader.listForRun('org-b', runId)).toEqual([]);
    });

    describe("a PR's comment", () => {
        const pr = () => ({ organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: Math.floor(Math.random() * 1e9) });

        it('of six deliveries at once, one holds the comment; a lapsed lease is taken by the next', async () => {
            const p = pr();
            const held = await Promise.all(Array.from({ length: 6 }, (_, i) => slots.acquire(p, `owner-${i}`, NOW)));
            expect(held.filter(Boolean)).toHaveLength(1);
            expect(await slots.acquire(p, 'late', plus(60_000))).toBeNull();
            expect(await slots.acquire(p, 'next', plus(3 * 60_000))).toMatchObject({ leaseOwner: 'next', leaseUntil: plus(5 * 60_000).toISOString() });
        });

        it('keeps the comment it created across holders; only the holder writes it, and a pending create is cleared', async () => {
            const p = pr();
            await slots.acquire(p, 'a', NOW);
            await slots.update(p, 'a', { comment: { id: 9 }, commentOrder: 2, createPending: true });
            await slots.update(p, 'intruder', { commentOrder: 99 });
            await slots.release(p, 'intruder');
            expect(await slots.acquire(p, 'b', plus(1_000))).toBeNull();
            await slots.update(p, 'a', { createPending: false });
            await slots.release(p, 'a');
            const next = await slots.acquire(p, 'b', plus(2_000));
            expect(next).toEqual({ ...p, comment: { id: 9 }, commentOrder: 2, leaseOwner: 'b', leaseUntil: plus(2_000 + 2 * 60_000).toISOString(), updatedAt: plus(2_000).toISOString() });
        });

        it("holds one comment per environment of a PR; a slot written before environments stays the repository's own", async () => {
            const p = pr();
            const other = { ...p, environmentKey: 'a1b2c3d4e5f60718' };
            expect(await slots.acquire(p, 'own', NOW)).not.toBeNull();
            // Another environment's Run of the same PR is not blocked by the lease, and never sees the other's comment.
            expect(await slots.acquire(other, 'other', NOW)).toMatchObject({ environmentKey: 'a1b2c3d4e5f60718', leaseOwner: 'other' });
            await slots.update(p, 'own', { comment: { id: 1 }, commentOrder: 10 });
            await slots.update(other, 'other', { comment: { id: 2 }, commentOrder: 20 });
            await slots.release(p, 'own');
            await slots.release(other, 'other');
            expect(await slots.acquire(p, 'own-2', plus(1_000))).toMatchObject({ comment: { id: 1 }, commentOrder: 10 });
            expect(await slots.acquire(other, 'other-2', plus(1_000))).toMatchObject({ comment: { id: 2 }, commentOrder: 20 });
            const legacy = await slots.acquire({ organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-legacy', prNumber: 1 }, 'x', NOW);
            expect(legacy).toMatchObject({ comment: { id: 5 }, commentOrder: 17630000000000 });
            expect(legacy).not.toHaveProperty('environmentKey');
        });

        it("keeps a real Run's comment order, a request time in ms times ten (past int4)", async () => {
            const p = pr();
            const order = commentOrderOf({ report: { requestedAt: NOW.toISOString() } } as Parameters<typeof commentOrderOf>[0])!;
            await slots.acquire(p, 'a', NOW);
            await slots.update(p, 'a', { commentOrder: order });
            await slots.release(p, 'a');
            expect((await slots.acquire(p, 'b', plus(1_000)))?.commentOrder).toBe(order);
        });
    });
});
