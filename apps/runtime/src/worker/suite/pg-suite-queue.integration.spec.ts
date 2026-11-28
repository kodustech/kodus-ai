import { Pool } from 'pg';

import { QUEUE_MAX_ATTEMPTS, type QueueEntry } from '@libs/runtime/suite';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgSuiteQueue } from './pg-suite-queue';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_queue');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const ORG = 'org-a';
const RUN = 'run-1';
const T0 = new Date('2026-11-27T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const entry = (spec: string, estMs: number | undefined, priority: 0 | 1 | 2 = 2): QueueEntry => ({ spec, priority, weight: estMs ?? 1, ...(estMs !== undefined ? { estMs } : {}) });

(skip ? describe.skip : describe)('runtime_suite_queue (real Postgres)', () => {
    let pool: Pool;
    let queue: PgSuiteQueue;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 12 });
        await ensureRuntimeSchema(pool);
        queue = new PgSuiteQueue(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_queue');
    });

    const claim = (shard: number, now = T0, extra: { maxSpecs?: number; targetMs?: number; leaseMs?: number } = {}) => queue.claimNext({ organizationId: ORG, suiteRunId: RUN, shard, now, ...extra });

    // Seeding the same run twice (a replayed workflow step) leaves the queue as it was.
    it('seeds a run once: a second seed adds nothing', async () => {
        expect(await queue.seed(ORG, RUN, [entry('a', 1000), entry('b', 2000)])).toBe(2);
        expect(await queue.seed(ORG, RUN, [entry('a', 1000), entry('b', 2000), entry('c', 3000)])).toBe(1);
        expect(await queue.counts(ORG, RUN)).toEqual({ queued: 3, claimed: 0, done: 0, abandoned: 0 });
    });

    // A shard that pulls gets the longest spec first, alone when it fills the batch target by itself.
    it('hands out the longest spec first, alone when it is as long as the batch target', async () => {
        await queue.seed(ORG, RUN, [entry('short', 5_000), entry('long', 120_000), entry('mid', 30_000)]);
        expect(await claim(0)).toEqual(['long']);
        expect(await claim(1)).toEqual(['mid', 'short']);
    });

    // Short specs ride together up to the maximum, and the order inside the pull is the queue's.
    it('batches short specs up to the maximum per pull', async () => {
        await queue.seed(ORG, RUN, Array.from({ length: 8 }, (_, i) => entry(`s${i}`, 1_000 + i)));
        const first = await claim(0, T0, { maxSpecs: 3 });
        expect(first).toEqual(['s7', 's6', 's5']);
    });

    // A spec red on the previous push is handed out before a longer one (the risk-first order of the design).
    it('hands out a higher priority before a longer spec', async () => {
        await queue.seed(ORG, RUN, [entry('long', 100_000), entry('redBefore', 1_000, 0)]);
        expect(await claim(0, T0, { maxSpecs: 1 })).toEqual(['redBefore']);
    });

    // With no estimate stored at all every pull is one spec, so nothing is batched on a guess.
    it('pulls one spec at a time when nothing is estimated', async () => {
        await queue.seed(ORG, RUN, [entry('a', undefined), entry('b', undefined), entry('c', undefined)]);
        expect(await claim(0)).toHaveLength(1);
    });

    // Many shards pulling at the same instant never get the same spec, and between them they get every spec.
    it('never hands one spec to two shards when they pull at once', async () => {
        const specs = Array.from({ length: 60 }, (_, i) => `spec-${String(i).padStart(2, '0')}.cy.ts`);
        await queue.seed(ORG, RUN, specs.map((s, i) => entry(s, 5_000 + i)));
        const got: string[][] = Array.from({ length: 10 }, () => []);
        await Promise.all(
            got.map(async (mine, shard) => {
                for (;;) {
                    const batch = await claim(shard, T0, { maxSpecs: 2 });
                    if (batch.length === 0) return;
                    mine.push(...batch);
                }
            }),
        );
        const all = got.flat();
        expect(new Set(all).size).toBe(all.length);
        expect([...all].sort()).toEqual([...specs].sort());
        expect((await queue.counts(ORG, RUN)).claimed).toBe(60);
    });

    // A pull that loses its rows to a sibling at the same instant must not report an empty queue while specs are still queued.
    it('does not report an empty queue to a shard that only lost a race', async () => {
        await queue.seed(ORG, RUN, Array.from({ length: 30 }, (_, i) => entry(`x${i}`, 90_000)));
        const pulls = await Promise.all(Array.from({ length: 12 }, (_, shard) => claim(shard)));
        expect(pulls.filter((p) => p.length === 0)).toHaveLength(0);
        expect(new Set(pulls.flat()).size).toBe(12);
    });

    // A shard that stops renewing loses its specs after the lease: they are queued again for another shard.
    it('re-queues the specs of a shard whose lease lapsed, and not before', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000)]);
        expect(await claim(0, T0, { leaseMs: 60_000 })).toEqual(['a']);
        expect(await queue.requeueExpired(ORG, RUN, at(59_999))).toEqual({ requeued: [], abandoned: [] });
        expect(await queue.requeueExpired(ORG, RUN, at(60_000))).toEqual({ requeued: ['a'], abandoned: [] });
        expect(await claim(1, at(60_000))).toEqual(['a']);
    });

    // A shard that is alive renews its lease and keeps its specs past the first lease.
    it('keeps the specs of a shard that renews its lease', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000)]);
        await claim(0, T0, { leaseMs: 60_000 });
        await queue.renew(ORG, RUN, 0, at(50_000), 60_000);
        expect(await queue.requeueExpired(ORG, RUN, at(100_000))).toEqual({ requeued: [], abandoned: [] });
        expect(await queue.requeueExpired(ORG, RUN, at(110_000))).toEqual({ requeued: ['a'], abandoned: [] });
    });

    // A spec handed out the maximum number of times and lost again is abandoned, not queued for ever.
    it('abandons a spec whose claim was lost after its last attempt', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000)]);
        for (let i = 0; i < QUEUE_MAX_ATTEMPTS; i++) {
            expect(await claim(i, at(i * 1_000_000))).toEqual(['a']);
            const lost = await queue.requeueExpired(ORG, RUN, at(i * 1_000_000 + 999_999));
            expect(i < QUEUE_MAX_ATTEMPTS - 1 ? lost.requeued : lost.abandoned).toEqual(['a']);
        }
        expect(await claim(5, at(9_000_000))).toEqual([]);
        expect(await queue.leftovers(ORG, RUN)).toEqual([{ spec: 'a', state: 'abandoned', claimedBy: QUEUE_MAX_ATTEMPTS - 1 }]);
    });

    // A shard that loses its host gives its unfinished specs back at once, without waiting for the lease; another shard's specs stay.
    it('releases only the specs of the shard that lost its host', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000), entry('b', 80_000)]);
        await claim(0, T0, { maxSpecs: 1 });
        await claim(1, T0, { maxSpecs: 1 });
        expect(await queue.release(ORG, RUN, 0, at(1_000))).toEqual({ requeued: ['a'], abandoned: [] });
        expect(await queue.counts(ORG, RUN)).toEqual({ queued: 1, claimed: 1, done: 0, abandoned: 0 });
    });

    // A finished spec is done for good: a late lease expiry or a release of its old holder cannot bring it back.
    it('does not bring a completed spec back', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000)]);
        await claim(0, T0, { leaseMs: 1_000 });
        await queue.complete(ORG, RUN, ['a'], at(500));
        expect(await queue.requeueExpired(ORG, RUN, at(10_000))).toEqual({ requeued: [], abandoned: [] });
        expect(await queue.release(ORG, RUN, 0, at(10_000))).toEqual({ requeued: [], abandoned: [] });
        expect(await queue.counts(ORG, RUN)).toEqual({ queued: 0, claimed: 0, done: 1, abandoned: 0 });
    });

    // Two suite runs never see each other's queue, and an organization cannot read another's.
    it('keeps runs and organizations apart', async () => {
        await queue.seed(ORG, RUN, [entry('a', 90_000)]);
        await queue.seed(ORG, 'run-2', [entry('a', 90_000)]);
        expect(await claim(0)).toEqual(['a']);
        expect(await queue.counts(ORG, 'run-2')).toEqual({ queued: 1, claimed: 0, done: 0, abandoned: 0 });
        expect(await queue.counts('org-b', RUN)).toEqual({ queued: 0, claimed: 0, done: 0, abandoned: 0 });
        expect(await queue.claimNext({ organizationId: 'org-b', suiteRunId: 'run-2', shard: 0, now: T0 })).toEqual([]);
    });
});
