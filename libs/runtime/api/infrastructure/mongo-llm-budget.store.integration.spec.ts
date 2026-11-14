import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { type Db, MongoClient } from 'mongodb';

import { planLlmCall } from '../domain/budget';
import { LlmBudgetBusyError } from '../domain/ports';
import {
    MongoRuntimeLlmBudgetStore,
    orgDayCounterKey,
    pullRequestCounterKey,
    RUNTIME_LLM_BUDGET_COLLECTION,
    RUNTIME_LLM_RESERVATIONS_COLLECTION,
    runCounterKey,
} from './mongo-llm-budget.store';

// S-47 against a real Mongo: concurrent reservations of one org meet on the
// counters' compare-and-swap, so together they never pass a limit.

// Opt-in: runs against the Mongo RUNTIME_IT_MONGO_URL names, in a database of
// its own that it drops, and skips when none is named.
const url = process.env.RUNTIME_IT_MONGO_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('MongoRuntimeLlmBudgetStore (integration, real Mongo)', () => {
    let client: MongoClient;
    let db: Db;
    let store: MongoRuntimeLlmBudgetStore;

    beforeAll(async () => {
        // The driver loads `os` with a dynamic import(), which fails inside Jest's VM and
        // leaves the handshake without client metadata; hand it the module instead.
        client = await MongoClient.connect(url, { serverSelectionTimeoutMS: 4_000, runtimeAdapters: { os } });
    });

    beforeEach(() => {
        // #2461: a prior case's settled usage must not become this case's budget.
        db = client.db(`it_llm_budget_${randomUUID().replaceAll('-', '')}`);
        store = new MongoRuntimeLlmBudgetStore(async () => db);
    });

    afterEach(async () => {
        await db?.dropDatabase();
    });

    afterAll(async () => {
        await client?.close();
    });

    const DAY = new Date('2026-11-03T00:00:00Z');
    const usage = (runId: string, prNumber = 7) => ({ runId, organizationId: 'org-a', repositoryId: '42', prNumber, task: 'runtime.plan', at: new Date('2026-11-03T12:00:00Z') });
    const limits = { perRun: 1_000, perPullRequest: 10_000, perOrgPerDay: 100_000 };
    const plan = (spend: Parameters<typeof planLlmCall>[0]) => {
        const p = planLlmCall(spend, limits, { inputTokens: 10, requestedOutputTokens: 200 });
        return p.allowed ? p.reserve : null;
    };
    const counter = async (id: string) => (await db.collection<{ _id: string; tokens: number }>(RUNTIME_LLM_BUDGET_COLLECTION).findOne({ _id: id }))?.tokens;
    const settledHundred = async () => {
        const res = await store.reserve({ usage: usage('run-1'), orgDayStart: DAY, decide: () => 100 });
        await store.settle(res!.reservationId, { inputTokens: 40, outputTokens: 60 });
    };

    it('reserves on all three scopes, settles to the real usage, and settles once', async () => {
        const res = await store.reserve({ usage: usage('run-1'), orgDayStart: DAY, decide: plan });
        expect(res?.tokens).toBe(210);
        expect(await store.totalForRun('run-1')).toBe(210);
        expect(await counter(pullRequestCounterKey(usage('run-1')))).toBe(210);
        expect(await counter(orgDayCounterKey('org-a', DAY))).toBe(210);

        await store.settle(res!.reservationId, { inputTokens: 40, outputTokens: 60 });
        await store.settle(res!.reservationId, { inputTokens: 40, outputTokens: 60 });
        expect(await store.totalForRun('run-1')).toBe(100);
        expect(await counter(orgDayCounterKey('org-a', DAY))).toBe(100);
        expect(await db.collection(RUNTIME_LLM_RESERVATIONS_COLLECTION).countDocuments({ _id: res!.reservationId as any })).toBe(0);
    });

    it("keeps the Run's settled tokens by model for its cost, and reads many Runs at once", async () => {
        const a = await store.reserve({ usage: usage('run-cost', 9), orgDayStart: DAY, decide: () => 500 });
        await store.settle(a!.reservationId, { inputTokens: 300, outputTokens: 40, cacheReadTokens: 200, model: 'claude-sonnet-4.5' });
        const b = await store.reserve({ usage: usage('run-cost', 9), orgDayStart: DAY, decide: () => 500 });
        await store.settle(b!.reservationId, { inputTokens: 100, outputTokens: 10 });
        // A reservation still in flight counts on the budget but has no model yet.
        await store.reserve({ usage: usage('run-cost', 9), orgDayStart: DAY, decide: () => 50 });

        const got = await store.usageForRuns(['run-cost', 'run-none']);
        expect([...got.keys()]).toEqual(['run-cost']);
        expect(got.get('run-cost')!.tokens).toBe(500);
        expect(got.get('run-cost')!.byModel).toEqual(
            expect.arrayContaining([
                { model: 'claude-sonnet-4.5', inputTokens: 300, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0 },
                { model: undefined, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            ]),
        );
    });

    it('gives back a cancelled reservation', async () => {
        await settledHundred();
        const res = await store.reserve({ usage: usage('run-1'), orgDayStart: DAY, decide: () => 50 });
        expect(await store.totalForRun('run-1')).toBe(150);
        await store.cancel(res!.reservationId);
        expect(await store.totalForRun('run-1')).toBe(100);
    });

    it('decides on what the scopes already spent and refuses past the limit', async () => {
        await settledHundred();
        const seen: unknown[] = [];
        const res = await store.reserve({
            usage: usage('run-other', 7),
            orgDayStart: DAY,
            decide: (spend) => {
                seen.push(spend);
                return null;
            },
        });
        expect(res).toBeNull();
        // Another Run of the same PR, same org and day: only the Run scope is new.
        expect(seen).toEqual([{ run: 0, pullRequest: 100, orgToday: 100 }]);
        expect(await store.totalForRun('run-other')).toBe(0);
    });

    it('lets concurrent calls of one org never pass the limit together', async () => {
        const results = await Promise.all(Array.from({ length: 12 }, () => store.reserve({ usage: usage('run-2', 8), orgDayStart: DAY, decide: plan })));
        const granted = results.filter(Boolean);
        expect(results.some((r) => r === null)).toBe(true);
        expect(granted.length).toBeGreaterThan(0);
        const total = granted.reduce((n, r) => n + r!.tokens, 0);
        expect(total).toBeLessThanOrEqual(1_000);
        // The counters hold exactly what was granted: every lost swap gave its tokens back.
        expect(await store.totalForRun('run-2')).toBe(total);
        expect(await counter(pullRequestCounterKey(usage('run-2', 8)))).toBe(total);
    });

    it('refuses with LlmBudgetBusyError when the counters never hold still, and gives back what it took', async () => {
        // A Db whose counter reads are always one token behind: every swap loses.
        const behind = (c: any) =>
            new Proxy(c, {
                get: (t, k) =>
                    k === 'find'
                        ? (...a: unknown[]) => ({ toArray: async () => (await t.find(...a).toArray()).map((d: any) => ({ ...d, tokens: d.tokens + 1 })) })
                        : typeof t[k] === 'function'
                          ? t[k].bind(t)
                          : t[k],
            });
        const stale = new Proxy(db, {
            get: (t: any, k) =>
                k === 'collection' ? (name: string) => (name === RUNTIME_LLM_BUDGET_COLLECTION ? behind(t.collection(name)) : t.collection(name)) : t[k],
        });
        const busy = new MongoRuntimeLlmBudgetStore(async () => stale as Db, async () => undefined);
        // A fresh org and PR: the first attempt creates their counters, loses on the
        // Run's (already there), and must give back what it put on the other two.
        const u = { ...usage('run-busy', 9), organizationId: 'org-busy' };
        await db.collection<{ _id: string; tokens: number }>(RUNTIME_LLM_BUDGET_COLLECTION).insertOne({ _id: runCounterKey('run-busy'), tokens: 0 });
        const err = await busy.reserve({ usage: u, orgDayStart: DAY, decide: () => 5 }).catch((e) => e);
        expect(err).toBeInstanceOf(LlmBudgetBusyError);
        expect(await counter(orgDayCounterKey('org-busy', DAY))).toBe(0);
        expect(await counter(pullRequestCounterKey(u))).toBe(0);
        expect(await counter(runCounterKey('run-busy'))).toBe(0);
        expect(await db.collection(RUNTIME_LLM_RESERVATIONS_COLLECTION).countDocuments({ runId: 'run-busy' })).toBe(0);
    });

    it('expires only the per-day counter and the reservations', async () => {
        for (const organizationId of ['org-a', 'org-busy']) {
            await store.reserve({ usage: { ...usage(`ttl-${organizationId}`), organizationId }, orgDayStart: DAY, decide: () => 1 });
        }
        const indexes = async (c: string) => (await db.collection(c).indexes()).filter((i) => i.expireAfterSeconds === 0).map((i) => i.key);
        expect(await indexes(RUNTIME_LLM_BUDGET_COLLECTION)).toEqual([{ expiresAt: 1 }]);
        expect(await indexes(RUNTIME_LLM_RESERVATIONS_COLLECTION)).toEqual([{ expiresAt: 1 }]);
        const docs = await db.collection<{ _id: string; expiresAt?: Date }>(RUNTIME_LLM_BUDGET_COLLECTION).find({ expiresAt: { $exists: true } }).toArray();
        expect(docs.map((d) => d._id).sort()).toEqual([orgDayCounterKey('org-a', DAY), orgDayCounterKey('org-busy', DAY)].sort());
    });
});
