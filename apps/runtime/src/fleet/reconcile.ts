import type { HostProvider } from '@libs/runtime/fleet/host-provider';
import { cellBaseOf } from '@libs/runtime/fleet/pool';

import { fleetHostId, type FleetStore, type StoredPool } from './fleet-store';
import type { PerRunHostInput } from './per-run-host';

// One pass of the fleet controller (docs/runtime/host-providers.md §7.0): a
// level-triggered loop over Postgres rows (the Runs that asked for a host)
// and the provider's own list (what exists). It decides; each host's life is
// its own DBOS workflow, started here and idempotent by its id. Runs under
// the fleet's DistributedLocks lock, so one replica decides at a time.

/** After this long with no new failure, a pool whose breaker opened tries one host again (half-open). */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

export interface ReconcileDeps {
    store: FleetStore;
    /** Starts the host's workflow; a second start of the same host is a no-op. */
    start(input: PerRunHostInput): Promise<void>;
    providerFor(kind: string): HostProvider | undefined;
    installation: string;
    now(): number;
    log(msg: string, fields: Record<string, unknown>): void;
    /** The setup hosts of environment templates building now (runtime_env_templates): not in the host rows, never orphans. */
    templateSetupHosts?(): Promise<string[]>;
}

export interface ReconcileResult {
    started: string[];
    destroyed: string[];
}

export async function reconcileOnce(d: ReconcileDeps, opts: { orphans?: boolean } = {}): Promise<ReconcileResult> {
    const out: ReconcileResult = { started: [], destroyed: [] };
    const { pools, invalid } = await d.store.controlledPools();
    for (const poolId of invalid) d.log('fleet.pool.invalid_spec', { poolId });
    for (const p of pools) {
        const status = await statusOf(p, d);
        await d.store.setPoolStatus(p.poolId, status);
        if (!status.scalable) continue;
        for (const demand of await d.store.openDemand(p.poolId)) {
            const hostId = demand.hostId ?? fleetHostId(p.poolId, demand.boundKey);
            if (!demand.hostId && !(await d.store.claimDemand(p.poolId, demand.boundKey, hostId))) continue;
            // A host already on its way is its workflow's; one never started (a start lost with its replica) starts now.
            if (demand.hostId && (await d.store.host(hostId))) continue;
            await d.start({ hostId, poolId: p.poolId, boundKey: demand.boundKey, organizationId: demand.organizationId, environmentId: demand.environmentId });
            out.started.push(hostId);
        }
    }
    if (opts.orphans) out.destroyed = await destroyOrphans(pools, d);
    return out;
}

async function statusOf(p: StoredPool, d: ReconcileDeps): Promise<{ scalable: boolean; reason?: string; hostClass?: { memoryMb: number; cpus: number } }> {
    if (p.pool.lifecycle !== 'perRun') return { scalable: false, reason: 'lifecycle_not_built' };
    const provider = d.providerFor(p.pool.provider);
    if (!provider) return { scalable: false, reason: 'provider_not_configured' };
    const failures = p.status.consecutiveFailures ?? 0;
    const lastFailureAt = p.status.lastFailureAt ? Date.parse(p.status.lastFailureAt) : 0;
    if (failures >= p.pool.health.maxConsecutiveFailures && d.now() - lastFailureAt < BREAKER_COOLDOWN_MS) return { scalable: false, reason: 'breaker_open' };
    // A boat host boots only from a saved image: with no cell base to fall back on, a Run whose environment has no
    // template would fail at once, so the pool takes none and placement moves it on (§8.2).
    if (p.pool.provider === 'boat') {
        const base = cellBaseOf(p.pool.hostClass);
        if (!base) return { scalable: false, reason: 'base_missing' };
        // An unanswered read changes nothing, as for quotas below.
        const image = provider.images ? await provider.images.get(base).catch(() => undefined) : undefined;
        if (image === null || (image && image.state !== 'ready')) return { scalable: false, reason: 'base_missing' };
    }
    // The provider's own word on starts and sizes, when it has one; an unanswered read changes nothing.
    const quotas = await provider.quotas(p.pool.hostClass).catch(() => null);
    if (quotas && !quotas.classAvailable) return { scalable: false, reason: 'class_unavailable' };
    if (quotas && !quotas.canStart) return { scalable: false, reason: 'cannot_start' };
    if (quotas && quotas.startsRemaining.minute === 0) return { scalable: false, reason: 'rate_budget' };
    const facts = provider.describe(p.pool.hostClass);
    return { scalable: true, hostClass: { memoryMb: facts.memoryMb, cpus: facts.vcpu } };
}

/**
 * A provider host of this installation whose tag names no live host row was never ours to keep: its row is
 * terminated or was never written (rows are written before every create). Destroyed, never another
 * installation's (list filters by the installation tag, destroy refuses it).
 *
 * The provider is listed before the rows are read. Per-host workflows run on every replica, outside the
 * reconcile lock, and each writes its row before its create: a machine the list returns had its row
 * written before the list began, so the read after it sees that row. Reading the rows first would miss a
 * host made between the two reads and destroy it.
 */
async function destroyOrphans(pools: StoredPool[], d: ReconcileDeps): Promise<string[]> {
    const destroyed: string[] = [];
    for (const kind of new Set(pools.map((p) => p.pool.provider))) {
        const provider = d.providerFor(kind);
        if (!provider) continue;
        let hosts;
        try {
            hosts = await provider.list({ installation: d.installation });
        } catch (e) {
            d.log('fleet.orphan.list_failed', { provider: kind, error: (e as Error).name });
            continue;
        }
        if (hosts.length === 0) continue;
        const live = new Set([...(await d.store.liveHosts()).map((h) => h.hostId), ...((await d.templateSetupHosts?.()) ?? [])]);
        for (const h of hosts) {
            if (h.tags.host && live.has(h.tags.host)) continue;
            await provider.destroy(h.providerId);
            destroyed.push(h.providerId);
            d.log('fleet.orphan.destroyed', { provider: kind, providerId: h.providerId, hostId: h.tags.host ?? null });
        }
    }
    return destroyed;
}
