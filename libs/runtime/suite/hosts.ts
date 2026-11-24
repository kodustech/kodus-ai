// The hosts a suite run gets (docs/runtime/e2e-suites.md section 5): the run asks for one per shard, never more than
// the pool can start now, and spreads its specs over the hosts it really got instead of waiting for a missing one.
// Pure: the fleet and the engine call it.

import { balanceSpecs, type SpecStats, type SuiteSpecFile } from './balance';

/** How many hosts to ask for: one per shard, at most what the pool can start now, at least one. */
export function hostsToAsk(shards: number, headroom: number): number {
    return Math.max(1, Math.min(Math.floor(shards), Math.floor(headroom)));
}

export interface ShardSpecs {
    shard: number;
    specs: string[];
}

/**
 * Every spec onto the shards that have a host (`hostShards`, their indexes), balanced by the stored durations.
 * The shards without a host get none; with every host there it is the plan the balance made. No host: nothing.
 */
export function spreadOnto(specs: readonly SuiteSpecFile[], stats: SpecStats, hostShards: readonly number[]): ShardSpecs[] {
    const shards = [...new Set(hostShards)].sort((a, b) => a - b);
    if (shards.length === 0) return [];
    const plan = balanceSpecs(specs, stats, shards.length);
    return plan.bins.map((bin, i) => ({ shard: shards[i], specs: bin.specs }));
}
