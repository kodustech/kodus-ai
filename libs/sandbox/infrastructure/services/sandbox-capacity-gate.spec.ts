import { FakeCapacityStore } from './sandbox-capacity-fake.store';
import {
    SandboxCapacityEnv,
    SandboxCapacityGate,
    readSandboxCapacityEnv,
} from './sandbox-capacity-gate';

const timing = { pollMs: 1000, heartbeatMs: 15_000, deadAfterMs: 45_000 };

/** A worker: a gate over the shared store. Each poll sleep is 1s of fake time. */
function worker(store: FakeCapacityStore, env: SandboxCapacityEnv, clock: { t: number }) {
    return new SandboxCapacityGate(
        store,
        () => env,
        () => clock.t,
        async () => {
            clock.t += 1000;
            await new Promise((r) => setImmediate(r));
        },
        timing,
    );
}
const tick = () => new Promise((r) => setImmediate(r));
const rel = (g: any) => g.release();

describe('SandboxCapacityGate (Mongo tickets)', () => {
    it('never exceeds the cap when two workers race', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 2, maxWaitMs: 600_000 };
        const workers = [worker(store, env, clock), worker(store, env, clock)];
        let live = 0;
        let peak = 0;
        const runs = Array.from({ length: 12 }, (_, i) =>
            workers[i % 2].acquire(`h${i}`, `org:repo:${i}`).then(async (g) => {
                expect(g.outcome).toBe('granted');
                live++;
                peak = Math.max(peak, live, store.slots.length);
                await tick();
                live--;
                await rel(g);
            }),
        );
        await Promise.all(runs);
        expect(peak).toBeLessThanOrEqual(2);
        expect(peak).toBe(2);
        expect(store.slots).toHaveLength(0);
    });

    it('serves strictly FIFO across workers', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 1, maxWaitMs: 600_000 };
        const a = worker(store, env, clock);
        const b = worker(store, env, clock);
        const first: any = await a.acquire('first', 'k:r:0');
        const order: string[] = [];
        const waits: Promise<void>[] = [];
        for (const [i, id] of ['w1', 'w2', 'w3', 'w4'].entries()) {
            clock.t += 10; // distinct createdAt, alternating workers
            waits.push(
                (i % 2 ? a : b).acquire(id, `k:r:${id}`).then(async (g) => {
                    order.push(id);
                    await rel(g);
                }),
            );
            await tick();
        }
        await rel(first);
        await Promise.all(waits);
        expect(order).toEqual(['w1', 'w2', 'w3', 'w4']);
    });

    it('reaps the slot of a dead worker', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 1, maxWaitMs: 600_000 };
        const dead = worker(store, env, clock);
        const grant: any = await dead.acquire('crashed', 'k:r:1');
        // The crashed worker never heartbeats again: no timer fires in this
        // spec (fake clock), so its slot just ages past deadAfterMs
        const alive = worker(store, env, clock);
        const second = await alive.acquire('next', 'k:r:2');
        expect(second.outcome).toBe('granted');
        expect(store.slots.map((s) => s.ticketId)).toEqual(['next']);
        await rel(second);
        await rel(grant);
    });

    it('times out after the max wait so the caller can degrade', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const a = worker(store, { maxConcurrent: 1, maxWaitMs: 5_000 }, clock);
        const held: any = await a.acquire('holder', 'k:r:1');
        // keep the holder alive on the fake clock
        const keep = setInterval(() => store.heartbeatSlot('holder', new Date(clock.t)), 1);
        const late = await a.acquire('late', 'k:r:2');
        clearInterval(keep);
        expect(late.outcome).toBe('timeout');
        expect(late.waitedMs).toBeGreaterThanOrEqual(5_000);
        expect(store.tickets).toHaveLength(0);
        await rel(held);
    });

    it('cancelPrKey deletes the waiting ticket, from any worker', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 1, maxWaitMs: 600_000 };
        const a = worker(store, env, clock);
        const b = worker(store, env, clock);
        const held: any = await a.acquire('holder', 'k:r:1');
        const queued = b.acquire('old', 'k:r:2');
        await tick();
        const keep = setInterval(() => store.heartbeatSlot('holder', new Date(clock.t)), 1);
        expect(await a.cancelPrKey('k:r:2')).toBe(1);
        expect((await queued).outcome).toBe('cancelled');
        clearInterval(keep);
        expect(store.slots).toHaveLength(1);
        await rel(held);
    });

    it('reports deployment-wide in-use, queued and oldest wait', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 1, maxWaitMs: 600_000 };
        const a = worker(store, env, clock);
        const b = worker(store, env, clock);
        const held: any = await a.acquire('holder', 'k:r:1');
        void b.acquire('waiting', 'k:r:2');
        await tick();
        const n = await a.numbers(); // read from a worker with nothing queued
        expect(n).toMatchObject({ inUse: 1, cap: 1, queued: 1 });
        expect(n.oldestWaitMs).toBeGreaterThanOrEqual(0);
        await b.cancelPrKey('k:r:2');
        await rel(held);
    });

    it('is off without a cap', async () => {
        const a = worker(new FakeCapacityStore(), { maxConcurrent: 0, maxWaitMs: 1 }, { t: 0 });
        expect((await a.acquire('x', 'k:r:1')).outcome).toBe('granted');
        expect(a.enabled).toBe(false);
        expect((await a.numbers()).inUse).toBeNull();
    });

    it('reads the env, ignoring malformed values', () => {
        expect(readSandboxCapacityEnv({})).toEqual({ maxConcurrent: 0, maxWaitMs: 600_000 });
        expect(
            readSandboxCapacityEnv({ SANDBOX_MAX_CONCURRENT: '4', SANDBOX_QUEUE_MAX_WAIT_MS: '1000' }),
        ).toEqual({ maxConcurrent: 4, maxWaitMs: 1000 });
        expect(readSandboxCapacityEnv({ SANDBOX_MAX_CONCURRENT: 'abc' }).maxConcurrent).toBe(0);
    });
});

describe('SandboxCapacityGate persisted settings', () => {
    it('refreshes the settings before it decides and before it reports numbers', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 0, maxWaitMs: 600_000 };
        const refresh = jest.fn(async () => {
            env.maxConcurrent = 1;
        });
        const gate = new SandboxCapacityGate(store, () => env, () => clock.t, async () => { clock.t += 1000; }, timing, refresh);
        const g = await gate.acquire('a', 'org:repo:1');
        expect(g.outcome).toBe('granted');
        expect(store.slots).toHaveLength(1);
        expect((await gate.numbers()).cap).toBe(1);
        expect(refresh).toHaveBeenCalled();
        await rel(g);
    });

    it('a waiting review is freed when the cap is removed', async () => {
        const store = new FakeCapacityStore();
        const clock = { t: 1_000_000 };
        const env = { maxConcurrent: 1, maxWaitMs: 600_000 };
        const gate = new SandboxCapacityGate(store, () => env, () => clock.t, async () => { clock.t += 1000; env.maxConcurrent = 0; }, timing);
        const first = await gate.acquire('a', 'org:repo:1');
        const second = await gate.acquire('b', 'org:repo:2');
        expect(second.outcome).toBe('granted');
        await rel(first);
    });
});

