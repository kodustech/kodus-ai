import { type IsolationMinimum, isolationSatisfies } from '@libs/runtime/contracts/isolation';

// Which pools may take a claim, in order (docs/runtime/host-providers.md §6.2).
// Pure: the worker's cell directory reads the pool rows and runs this inside
// its reservation. Placement never calls a provider: when the first pool is a
// perRun one with no host for the Run, the directory records demand and the
// fleet makes the host.

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
}

export interface PlacementAsk {
    organizationId: string;
    /** 'runtime' (a Run's side), 'setup', 'sandbox', ... */
    consumer: string;
    runId?: string;
    isolation?: IsolationMinimum;
}

export interface Placement {
    /** Pool ids, best first. */
    pools: string[];
    /** Which of them make one host per Run (the directory reserves only the Run's bound cell there). */
    perRun: string[];
    /** The key a perRun host's cell is bound to: present when a perRun pool is a candidate. */
    boundKey?: string;
}

/** The key that binds a perRun host to one Run of one org. */
export const boundKeyOfRun = (organizationId: string, runId: string) => `run:${organizationId}/${runId}`;

/**
 * The pools the claim may use, in order: the org's own first, then by weight, then by id. null: no pool a
 * controller drives admits the claim, so placement is what it was before pools (every connected cell the org
 * may use), which keeps static-only installs, self-hosted and hybrid orgs exactly as they are.
 */
export function candidatePools(pools: readonly PoolView[], ask: PlacementAsk): Placement | null {
    const own = `org:${ask.organizationId}`;
    const runBound = ask.consumer === 'runtime' && !!ask.runId;
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
    const perRun = ordered.filter((p) => p.lifecycle === 'perRun').map((p) => p.poolId);
    return {
        pools: ordered.map((p) => p.poolId),
        perRun,
        ...(perRun.length ? { boundKey: boundKeyOfRun(ask.organizationId, ask.runId!) } : {}),
    };
}
