import {
    SandboxCapacityEnv,
    SandboxCapacityGate,
    SandboxCapacitySlot,
    SandboxCapacityStore,
    readSandboxCapacityEnv,
} from './sandbox-capacity-gate';

/** One shared "database": two gates over it are two workers. */
class FakeStore implements SandboxCapacityStore {
    readonly held = new Set<number>();
    async tryAcquire(i: number): Promise<SandboxCapacitySlot | null> {
        if (this.held.has(i)) return null;
        this.held.add(i);
        return { release: async () => void this.held.delete(i) };
    }
    async isHeld(i: number) {
        return this.held.has(i);
    }
}

function worker(store: SandboxCapacityStore, env: SandboxCapacityEnv, clock: { t: number }) {
    return new SandboxCapacityGate(
        store,
        () => env,
        () => clock.t,
        // A poll tick costs 1s of fake time and yields to other workers
        async (ms) => {
            clock.t += 1000;
            await new Promise((r) => setImmediate(r));
        },
    );
}

describe('SandboxCapacityGate', () => {
    it('holds the cap across two workers', async () => {
        const store = new FakeStore();
        const clock = { t: 0 };
        const env = { maxConcurrent: 2, maxWaitMs: 60_000 };
        const a = worker(store, env, clock);
        const b = worker(store, env, clock);

        const g1 = await a.acquire('pr1');
        const g2 = await b.acquire('pr2');
        expect([g1.outcome, g2.outcome]).toEqual(['granted', 'granted']);

        const third = b.acquire('pr3');
        await new Promise((r) => setImmediate(r));
        expect(store.held.size).toBe(2);
        expect((await a.numbers()).inUse).toBe(2);

        if (g1.outcome === 'granted') await g1.release();
        const g3 = await third;
        expect(g3.outcome).toBe('granted');
        expect(store.held.size).toBe(2);
    });

    it('serves one worker FIFO', async () => {
        const store = new FakeStore();
        const clock = { t: 0 };
        const a = worker(store, { maxConcurrent: 1, maxWaitMs: 600_000 }, clock);
        const first = await a.acquire('first');
        const order: string[] = [];
        const waits = ['x', 'y', 'z'].map((id) =>
            a.acquire(id).then((g) => {
                order.push(id);
                if (g.outcome === 'granted') return g.release();
            }),
        );
        await new Promise((r) => setImmediate(r));
        if (first.outcome === 'granted') await first.release();
        await Promise.all(waits);
        expect(order).toEqual(['x', 'y', 'z']);
    });

    it('times out after the max wait so the caller can degrade', async () => {
        const store = new FakeStore();
        const clock = { t: 0 };
        const a = worker(store, { maxConcurrent: 1, maxWaitMs: 5_000 }, clock);
        await a.acquire('holder');
        const late = await a.acquire('late');
        expect(late.outcome).toBe('timeout');
        expect(late.waitedMs).toBeGreaterThanOrEqual(5_000);
        expect((await a.numbers()).queued).toBe(0);
    });

    it('cancel() drops a queued wait without taking a slot', async () => {
        const store = new FakeStore();
        const clock = { t: 0 };
        const a = worker(store, { maxConcurrent: 1, maxWaitMs: 600_000 }, clock);
        await a.acquire('holder');
        const queued = a.acquire('old-push');
        await new Promise((r) => setImmediate(r));
        expect(a.cancel('old-push')).toBe(1);
        expect((await queued).outcome).toBe('cancelled');
        expect(store.held.size).toBe(1);
    });

    it('reports in-use, queued and oldest wait', async () => {
        const store = new FakeStore();
        const clock = { t: 0 };
        const a = worker(store, { maxConcurrent: 1, maxWaitMs: 600_000 }, clock);
        await a.acquire('holder');
        void a.acquire('waiting');
        await new Promise((r) => setImmediate(r));
        clock.t += 500;
        const n = await a.numbers();
        expect(n).toMatchObject({ inUse: 1, cap: 1, queued: 1 });
        expect(n.oldestWaitMs).toBeGreaterThan(0);
        a.cancel('waiting');
    });

    it('is off without a cap', async () => {
        const a = worker(new FakeStore(), { maxConcurrent: 0, maxWaitMs: 1 }, { t: 0 });
        expect((await a.acquire('x')).outcome).toBe('granted');
        expect(a.enabled).toBe(false);
    });

    it('reads the env, ignoring malformed values', () => {
        expect(readSandboxCapacityEnv({})).toEqual({ maxConcurrent: 0, maxWaitMs: 600_000 });
        expect(
            readSandboxCapacityEnv({ SANDBOX_MAX_CONCURRENT: '4', SANDBOX_QUEUE_MAX_WAIT_MS: '1000' }),
        ).toEqual({ maxConcurrent: 4, maxWaitMs: 1000 });
        expect(readSandboxCapacityEnv({ SANDBOX_MAX_CONCURRENT: 'abc' }).maxConcurrent).toBe(0);
    });
});
