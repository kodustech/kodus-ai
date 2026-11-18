import type { EnvError, LeaseRenewal } from '@libs/runtime/environment';

import { ClaimLeaseKeeper, LeaseEvent, RENEW_EVERY_MS, RENEW_RETRY_MS, RunLeaseHolds, Timers } from './lease-keeper';

// The keeper over a manual clock: each test advances time and lets the
// renewals the timers fired settle.

class ManualTimers implements Timers {
    now = 0;
    private next = 1;
    private readonly due = new Map<number, { at: number; fn: () => void }>();
    setTimeout(fn: () => void, ms: number) {
        const id = this.next++;
        this.due.set(id, { at: this.now + ms, fn });
        return id;
    }
    clearTimeout(id: unknown) {
        this.due.delete(id as number);
    }
    get pending() {
        return this.due.size;
    }
    async advance(ms: number) {
        const end = this.now + ms;
        for (;;) {
            const [id, t] = [...this.due.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
            if (id === undefined || t!.at > end) break;
            this.due.delete(id);
            this.now = t!.at;
            t!.fn();
            for (let i = 0; i < 10; i++) await Promise.resolve();
        }
        this.now = end;
        // What a renewal settled meanwhile (one released by the test) runs before the test looks.
        for (let i = 0; i < 10; i++) await Promise.resolve();
    }
}

const MIN = 60_000;
const renewed = (atCeiling = false): LeaseRenewal => ({ status: 'renewed', leaseExpiresAt: '2026-11-06T11:00:00.000Z', hardExpiresAt: '2026-11-06T11:00:00.000Z', atCeiling });

function harness(answer: (claimId: string, n: number) => Promise<LeaseRenewal | EnvError>) {
    const timers = new ManualTimers();
    const calls: Array<{ claimId: string; at: number }> = [];
    const events: LeaseEvent[] = [];
    const keeper = new ClaimLeaseKeeper(
        async (claimId) => {
            calls.push({ claimId, at: timers.now });
            return answer(claimId, calls.filter((c) => c.claimId === claimId).length);
        },
        { timers, onEvent: (e) => void events.push(e) },
    );
    return { keeper, timers, calls, events };
}

describe('ClaimLeaseKeeper', () => {
    it('renews every claim a third of the lease in, well before the 45-minute lease runs out', async () => {
        expect(RENEW_EVERY_MS).toBe(15 * MIN);
        const t = harness(async () => renewed());
        t.keeper.keep(['base', 'pr']);
        await t.timers.advance(15 * MIN - 1);
        expect(t.calls).toHaveLength(0);
        await t.timers.advance(1);
        expect(t.calls).toEqual([
            { claimId: 'base', at: 15 * MIN },
            { claimId: 'pr', at: 15 * MIN },
        ]);
        await t.timers.advance(15 * MIN);
        expect(t.calls.filter((c) => c.claimId === 'base').map((c) => c.at)).toEqual([15 * MIN, 30 * MIN]);
    });

    it('stops renewing a claim whose lease reached its hard ceiling: nothing can move it further', async () => {
        const t = harness(async (claimId) => renewed(claimId === 'base'));
        t.keeper.keep(['base', 'pr']);
        await t.timers.advance(60 * MIN);
        expect(t.calls.filter((c) => c.claimId === 'base')).toHaveLength(1);
        expect(t.calls.filter((c) => c.claimId === 'pr')).toHaveLength(4);
        expect(t.events).toContainEqual(expect.objectContaining({ type: 'renewed', claimId: 'base', atCeiling: true }));
    });

    it('stops for good after stop(): no renewal once the Run released its claims', async () => {
        const t = harness(async () => renewed());
        const hold = t.keeper.keep(['base', 'pr']);
        await t.timers.advance(15 * MIN);
        hold.stop();
        expect(t.timers.pending).toBe(0);
        await t.timers.advance(60 * MIN);
        expect(t.calls).toHaveLength(2);
    });

    it('a renewal in flight when the Run stops schedules nothing after it', async () => {
        let release!: () => void;
        const t = harness(() => new Promise((r) => (release = () => r(renewed()))));
        const hold = t.keeper.keep(['base']);
        await t.timers.advance(15 * MIN);
        expect(t.calls).toHaveLength(1);
        hold.stop();
        release();
        await t.timers.advance(60 * MIN);
        expect(t.calls).toHaveLength(1);
        expect(t.events).toEqual([]);
    });

    it('drops a claim the hub says is gone (released, expired or unknown on its cell)', async () => {
        const t = harness(async (claimId) => (claimId === 'pr' ? { status: 'gone' } : renewed()));
        t.keeper.keep(['base', 'pr']);
        await t.timers.advance(45 * MIN);
        expect(t.calls.filter((c) => c.claimId === 'pr')).toHaveLength(1);
        expect(t.calls.filter((c) => c.claimId === 'base')).toHaveLength(3);
        expect(t.events).toContainEqual({ type: 'gone', claimId: 'pr' });
    });

    it('a lost cell or hub never throws out of the keeper: it retries a minute later and recovers', async () => {
        const t = harness(async (_claimId, n) => {
            if (n === 1) throw new Error('hub unreachable: ECONNRESET');
            if (n === 2) return { code: 'cell_unavailable', cellId: 'unknown' };
            return renewed();
        });
        t.keeper.keep(['base']);
        await t.timers.advance(15 * MIN);
        await t.timers.advance(RENEW_RETRY_MS);
        await t.timers.advance(RENEW_RETRY_MS);
        expect(t.calls.map((c) => c.at)).toEqual([15 * MIN, 15 * MIN + RENEW_RETRY_MS, 15 * MIN + 2 * RENEW_RETRY_MS]);
        expect(t.events.map((e) => e.type)).toEqual(['retry', 'retry', 'renewed']);
        // Back to the normal cadence after the miss.
        await t.timers.advance(15 * MIN);
        expect(t.calls).toHaveLength(4);
    });

    it('a log sink that throws does not stop the renewals', async () => {
        const timers = new ManualTimers();
        let calls = 0;
        const keeper = new ClaimLeaseKeeper(async () => (calls++, renewed()), {
            timers,
            onEvent: () => {
                throw new Error('log down');
            },
        });
        keeper.keep(['base']);
        await timers.advance(30 * MIN);
        expect(calls).toBe(2);
    });
});

describe('RunLeaseHolds: a Run keeps each claim from its own boot', () => {
    const recording = () => {
        const log: string[] = [];
        return { log, leases: { keep: (ids: string[]) => (log.push(`keep:${ids.join(',')}`), { stop: () => void log.push(`stop:${ids.join(',')}`) }) } };
    };

    it('keeps a claim once, drops one the Run gives back, and stops the rest', () => {
        const { log, leases } = recording();
        const holds = new RunLeaseHolds(leases);
        holds.add('base-1');
        holds.add('base-1');
        holds.add('pr-1');
        holds.drop('base-1');
        holds.add('base-2');
        holds.stop();
        expect(log).toEqual(['keep:base-1', 'keep:pr-1', 'stop:base-1', 'keep:base-2', 'stop:pr-1', 'stop:base-2']);
    });

    it('keeps nothing after stop, and nothing without a keeper', () => {
        const { log, leases } = recording();
        const holds = new RunLeaseHolds(leases);
        holds.stop();
        holds.add('late');
        expect(log).toEqual([]);
        const none = new RunLeaseHolds(undefined);
        none.add('x');
        none.stop();
    });
});
