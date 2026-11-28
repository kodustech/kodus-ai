import { createHash } from 'node:crypto';

import { type IsolationMinimum, isolationSatisfies } from '@libs/runtime/contracts/isolation';

// Which pools may take a claim, in order (docs/runtime/host-providers.md §6.2).
// Pure: the worker's cell directory reads the pool rows and runs this inside
// its reservation. Placement never calls a provider: when the first pool is a
// perRun one with no host for the Run (or the setup, or the suite shard), the
// directory records demand and the fleet makes the host.

/** A pool as placement reads it: runtime_host_pools spec and status, flattened. */
export interface PoolView {
    poolId: string;
    /** 'kodus' or 'org:<organizationId>'. */
    scope: string;
    provider: string;
    lifecycle: 'perRun' | 'pooled';
    weight: number;
    labels: { isolation?: 'vm' | 'microvm' | 'sandboxed-container' };
    /** Absent: every org the scope admits. */
    allowOrgs?: string[];
    cordoned: boolean;
    /** The controller's word: false while its breaker is open or its start budget is spent. */
    scalable: boolean;
    /** What one perRun host of the pool's class holds (the controller's word, from the provider adapter); absent: unknown, so the pair is assumed to fit. */
    hostClass?: HostCapacity;
}

/** What a host holds, in MB and CPUs, before the cell's own reserve. */
export interface HostCapacity {
    memoryMb: number;
    cpus: number;
}

/** A Run's two sides: the machine size each claims. */
export interface PairSize {
    memoryMb: number;
    cpus: number;
}

/** What the cell keeps for the host itself (Docker, the cell, egress): the cell's -memory-reserve-mb default. */
export const CELL_MEMORY_RESERVE_MB = 1024;

/**
 * Whether a Run's base and PR claims together fit one host of the class: their memory and CPUs (both sides run at
 * once) against the host's memory less the cell's reserve, and its CPUs. Unknown capacity: it fits (today's single
 * host), because placement must not split on a guess.
 */
export function pairFitsHost(pair: PairSize, host: HostCapacity | undefined, reserveMb: number = CELL_MEMORY_RESERVE_MB): boolean {
    if (!host) return true;
    return pair.memoryMb * 2 <= host.memoryMb - reserveMb && pair.cpus * 2 <= host.cpus;
}

export interface PlacementAsk {
    organizationId: string;
    /** 'runtime' (a Run's side), 'setup', 'sandbox', ... */
    consumer: string;
    runId?: string;
    /** A suite shard (consumer 'suite'): the suite run and the shard's index, which together name its host. */
    suiteRunId?: string;
    shard?: number;
    /** An environment's own setup (consumer 'setup'): its key names the perRun host bound to that setup. */
    setupKey?: string;
    isolation?: IsolationMinimum;
    /** A Run's side (consumer 'runtime'): which side is placed, so a pair that does not fit one host gets one key per side. */
    side?: RunSide;
    /** The machine size of each of the Run's sides (the environment's size): with the pool's host class, decides whether the pair splits. */
    sideSize?: PairSize;
}

export type RunSide = 'base' | 'pr';

export interface Placement {
    /** Pool ids, best first. */
    pools: string[];
    /** Which of them make one host per Run (the directory reserves only the Run's bound cell there). */
    perRun: string[];
    /** The key a perRun host's cell is bound to: present when a perRun pool is a candidate. */
    boundKey?: string;
    /** The Run's pair does not fit one host of the first perRun pool: each side has its own bound key (run:<org>/<run>/<side>). */
    splitSides?: boolean;
}

/** The key that binds a perRun host to one side of one Run of one org, for a pair that does not fit one host. */
export const boundKeyOfRunSide = (organizationId: string, runId: string, side: RunSide) => `run:${organizationId}/${runId}/${side}`;

/** The key that binds a perRun host to one Run of one org. */
export const boundKeyOfRun = (organizationId: string, runId: string) => `run:${organizationId}/${runId}`;

/** The key that binds a template's setup host to one environment of one org (docs/runtime/host-providers.md §8.2): it receives only that environment's setup. */
export const boundKeyOfTemplate = (organizationId: string, environmentId: string) => `template:${organizationId}/${environmentId}`;

/**
 * The key that binds a perRun host to one setup of an environment (not a template build): the setup's own boot and
 * Kody's repair boots, which share the setup's key, use that host and its build cache; the next setup gets a host of its
 * own. Per setup, never per environment: the host id and its workflow are derived from the key, so a key reused by the
 * next setup would find the previous host's demand row and never start a host. The setup key is hashed so the bound key
 * stays short and has no character the cell's key pattern refuses.
 */
export const boundKeyOfSetup = (organizationId: string, setupKey: string) =>
    `setup:${organizationId}/${createHash('sha256').update(setupKey).digest('hex').slice(0, 32)}`;

/** The key that binds a perRun host to one shard of one suite run of one org (docs/runtime/e2e-suites.md section 5). */
export const boundKeyOfSuite = (organizationId: string, suiteRunId: string, shard: number) => `suite:${organizationId}/${suiteRunId}/${shard}`;

/**
 * The suite run and shard a `suite:<org>/<suiteRun>/<shard>` key names, only for the claim's own org and a
 * non-negative integer shard. Anything else (a Run's or a template's key, another org's, malformed) is null.
 */
export function suiteKeyOf(organizationId: string, key: string | undefined): { suiteRunId: string; shard: number } | null {
    if (!key) return null;
    const prefix = `suite:${organizationId}/`;
    if (!key.startsWith(prefix)) return null;
    const m = /^([^/\s]{1,128})\/(\d{1,3})$/.exec(key.slice(prefix.length));
    return m ? { suiteRunId: m[1], shard: Number(m[2]) } : null;
}

/**
 * The pools the claim may use, in order: the org's own first, then by weight, then by id. null: no pool a
 * controller drives admits the claim, so placement is what it was before pools (every connected cell the org
 * may use), which keeps static-only installs, self-hosted and hybrid orgs exactly as they are.
 */
export function candidatePools(pools: readonly PoolView[], ask: PlacementAsk): Placement | null {
    const own = `org:${ask.organizationId}`;
    const suiteBound = ask.consumer === 'suite' && !!ask.suiteRunId && ask.shard !== undefined;
    // An environment's own setup gets its own host too: with only boat pools there is no other machine to run it on.
    const setupBound = ask.consumer === 'setup' && !!ask.setupKey;
    const runBound = (ask.consumer === 'runtime' && !!ask.runId) || suiteBound || setupBound;
    const usable = pools.filter(
        (p) =>
            (p.scope === own || (p.scope === 'kodus' && (!p.allowOrgs || p.allowOrgs.includes(ask.organizationId)))) &&
            !p.cordoned &&
            p.scalable &&
            (p.lifecycle !== 'perRun' || runBound) &&
            (!ask.isolation || !p.labels.isolation || isolationSatisfies(p.labels.isolation, ask.isolation)),
    );
    if (!usable.some((p) => p.provider !== 'static')) return null;
    const ordered = [...usable].sort((a, b) => Number(b.scope === own) - Number(a.scope === own) || b.weight - a.weight || a.poolId.localeCompare(b.poolId));
    const perRunPools = ordered.filter((p) => p.lifecycle === 'perRun');
    const perRun = perRunPools.map((p) => p.poolId);
    // Decided here, where the host class and the size meet: a pair that cannot share the first perRun host gets a host per side.
    const splitSides =
        ask.consumer === 'runtime' && !!ask.runId && !!ask.sideSize && !!perRunPools.length && ordered[0] === perRunPools[0] && !pairFitsHost(ask.sideSize, perRunPools[0].hostClass);
    return {
        pools: ordered.map((p) => p.poolId),
        perRun,
        ...(perRun.length ? { boundKey: boundKeyOf(ask, suiteBound, setupBound, splitSides) } : {}),
        ...(splitSides ? { splitSides } : {}),
    };
}

function boundKeyOf(ask: PlacementAsk, suiteBound: boolean, setupBound: boolean, splitSides = false): string {
    if (suiteBound) return boundKeyOfSuite(ask.organizationId, ask.suiteRunId!, ask.shard!);
    if (setupBound) return boundKeyOfSetup(ask.organizationId, ask.setupKey!);
    if (splitSides && ask.side) return boundKeyOfRunSide(ask.organizationId, ask.runId!, ask.side);
    return boundKeyOfRun(ask.organizationId, ask.runId!);
}

/**
 * The template key a setup claim may carry (docs/runtime/host-providers.md §8.2): only `template:<org>/<env>` of
 * the claim's own org. Anything else (a Run's key, another org's template, malformed) is not a template setup.
 */
export function templateSetupKey(organizationId: string, key: string | undefined): string | null {
    if (!key) return null;
    const prefix = `template:${organizationId}/`;
    return key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes('/') ? key : null;
}
