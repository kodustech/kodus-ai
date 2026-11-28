import { balanceSpecs } from './balance';
import { hostsToAsk, spreadOnto } from './hosts';

const spec = (path: string, sizeBytes = 100) => ({ path, sizeBytes });
const specs = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => spec(`${n}.cy.ts`));
const stats = Object.fromEntries(specs.map((s, i) => [s.path, { p50Ms: (6 - i) * 60_000 }]));

describe('hosts a suite run asks for', () => {
    it('is one per shard, never more than the pool can start now, and at least one', () => {
        expect(hostsToAsk(3, 10)).toBe(3);
        expect(hostsToAsk(3, 2)).toBe(2);
        expect(hostsToAsk(3, 0)).toBe(1);
        expect(hostsToAsk(1, 5)).toBe(1);
    });
});

describe('spreading the specs over the hosts a suite run got', () => {
    const planned = balanceSpecs(specs, stats, 3);

    it('with every host there, keeps the plan the balance made', () => {
        expect(spreadOnto(specs, stats, [0, 1, 2])).toEqual(planned.bins.map((b, shard) => ({ shard, specs: b.specs })));
    });

    it('with fewer hosts than shards, every spec still runs once, on the shards that have a host, and none waits for the missing one', () => {
        const out = spreadOnto(specs, stats, [0, 2]);
        expect(out.map((s) => s.shard)).toEqual([0, 2]);
        const all = out.flatMap((s) => s.specs);
        expect(all.sort()).toEqual(specs.map((s) => s.path).sort());
        expect(new Set(all).size).toBe(specs.length);
    });

    it('balances what it spreads by the stored durations: the two hosts carry the same work within one spec', () => {
        const out = spreadOnto(specs, stats, [1, 2]);
        const ms = out.map((s) => s.specs.reduce((n, p) => n + stats[p].p50Ms, 0));
        expect(Math.abs(ms[0] - ms[1])).toBeLessThanOrEqual(60_000);
    });

    it('one host runs the whole suite', () => {
        expect(spreadOnto(specs, stats, [2])).toEqual([{ shard: 2, specs: [...specs.map((s) => s.path)].sort((a, b) => stats[b].p50Ms - stats[a].p50Ms || (a < b ? -1 : 1)) }]);
    });

    it('with no host there is nothing to spread onto', () => {
        expect(spreadOnto(specs, stats, [])).toEqual([]);
    });
});
