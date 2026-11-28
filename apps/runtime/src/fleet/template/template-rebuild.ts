import { cellBaseOf, type HostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import type { DistributedLocks } from '../../shared/persistence/locks';
import { bakeFingerprintOf } from './bake-probe';
import type { SetupCandidatesReader } from './setup-candidates-store';
import type { TemplateStore } from './template-store';
import type { TemplateBuildTrigger } from './template-trigger';
import { staleReason, type TemplateFreshnessPolicy } from './template-freshness';
import { staleBuild } from './template-watchdog';

// Nothing in the fleet process hears a setup finish (the setup runs in runtime-worker), so a periodic pass finds the
// environments whose default-branch setup baked a fingerprint no template holds yet and hands them to
// `TemplateBuildTrigger.onSetupFinished` (docs/runtime/host-providers.md §8.2). One replica runs it at a time.

export const TEMPLATE_REBUILD_LOCK = 'fleet.template_rebuild';
/** How far back a finished setup is looked at. */
export const REBUILD_WINDOW_MS = 24 * 3_600_000;
/** A fingerprint whose build failed this recently is left alone, so a broken bake is not rebuilt on every pass. */
export const REBUILD_FAILURE_BACKOFF_MS = 30 * 60_000;
const BATCH = 200;

/** A template build's own setup (bound key `template:`) is never a reason to build again; nor is a setup that is not active on the default branch. */
const eligible = (rec: EnvironmentSetupRecord) => rec.state === 'active' && rec.refSource === 'default_branch' && !rec.key.startsWith('template:');

export interface TemplateRebuildDeps {
    setups: SetupCandidatesReader;
    templates: Pick<TemplateStore, 'holds' | 'building' | 'failStale' | 'readyOfKey' | 'noteMain' | 'refreshInFlight'>;
    /** When a ready template of an unchanged key is rebuilt anyway (host-providers.md §8.2.2). Absent: never. */
    freshness?: TemplateFreshnessPolicy;
    /** The setup host ids the provider lists as alive; null when it could not be asked. Absent: the watchdog never judges by the host. */
    liveSetupHosts?(): Promise<Set<string> | null>;
    /** The boat perRun pools of the fleet, with the orgs each admits. */
    boatPools(): Promise<Array<{ poolId: string; pool: HostPool }>>;
    trigger: Pick<TemplateBuildTrigger, 'onSetupFinished' | 'onMainKept'>;
    now(): number;
    log?(msg: string, fields: Record<string, unknown>): void;
}

export class TemplateRebuildPass {
    private running = false;
    constructor(
        private readonly locks: DistributedLocks,
        private readonly d: TemplateRebuildDeps,
    ) {}

    /** One pass under the cluster lock; a failure is logged and the next pass runs. */
    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await this.locks.tryWithLock(TEMPLATE_REBUILD_LOCK, () => this.run());
        } catch (e) {
            this.d.log?.('template.rebuild_pass_failed', { error: (e as Error).message });
        } finally {
            this.running = false;
        }
    }

    async run(): Promise<number> {
        const pools = await this.d.boatPools();
        if (pools.length === 0) return 0;
        await this.reapStaleBuilds(pools);
        const admitted = (p: { pool: HostPool }, org: string) => !p.pool.admission || p.pool.admission.allowOrgs.includes(org);
        const orgs = pools.some((p) => !p.pool.admission) ? null : [...new Set(pools.flatMap((p) => p.pool.admission?.allowOrgs ?? []))];
        const now = this.d.now();
        const candidates = await this.d.setups.activeSince(new Date(now - REBUILD_WINDOW_MS), orgs, BATCH);
        let triggered = 0;
        for (const rec of candidates) {
            if (!eligible(rec)) continue;
            const why = await this.needsBuild(rec, pools.filter((p) => admitted(p, rec.organizationId)), now);
            if (!why) {
                // The template is kept although main moved: the main commit still gets its baseline suite run (e2e-suites.md section 2.1).
                await this.d.trigger.onMainKept(rec);
                continue;
            }
            triggered++;
            await this.d.trigger.onSetupFinished(rec, why === 'new' ? undefined : { refresh: why });
        }
        return triggered;
    }

    /**
     * Ends the `building` rows whose build died (a fleet restart drops the in-process build) or whose pool moved to another cell
     * base, so the normal pass below builds them again at once. A row of a pool this fleet does not control is left alone.
     */
    private async reapStaleBuilds(pools: Array<{ poolId: string; pool: HostPool }>): Promise<void> {
        const rows = await this.d.templates.building();
        if (rows.length === 0) return;
        const liveSetupHosts = (await this.d.liveSetupHosts?.()) ?? null;
        for (const row of rows) {
            const p = pools.find((x) => x.poolId === row.poolId);
            if (!p) continue;
            const reason = staleBuild(row, { poolCellBase: cellBaseOf(p.pool.hostClass) ?? '', liveSetupHosts });
            if (!reason) continue;
            if (await this.d.templates.failStale(row, row.setupHostId, reason))
                this.d.log?.('template.build_reaped', { environmentId: row.environmentId, poolId: row.poolId, reason, setupHostId: row.setupHostId, idleMs: row.idleMs });
        }
    }

    /**
     * 'new': a pool holds no template of this key (a build input changed, or none was ever built). A stale reason: the pool's ready
     * template of this key is past the freshness bound and no rebuild of it is under way, so it is built again beside the older one,
     * which keeps serving until the new one is promoted. Null: nothing to build. Also counts the main commit the setup shows.
     */
    private async needsBuild(rec: EnvironmentSetupRecord, pools: Array<{ poolId: string; pool: HostPool }>, now: number): Promise<'new' | 'max_age' | 'max_main_commits' | null> {
        const fingerprint = bakeFingerprintOf(rec);
        if (!fingerprint) return null;
        const failedAfter = new Date(now - REBUILD_FAILURE_BACKOFF_MS);
        let stale: 'max_age' | 'max_main_commits' | null = null;
        // A template of the pool's former cell base holds nothing: the pool moved to a new cell, and the template is built again on it.
        for (const p of pools) {
            const cellBase = cellBaseOf(p.pool.hostClass) ?? '';
            if (!(await this.d.templates.holds({ organizationId: rec.organizationId, environmentId: rec.environmentId, poolId: p.poolId, fingerprint, cellBase }, failedAfter))) return 'new';
            if (!this.d.freshness) continue;
            const key = { organizationId: rec.organizationId, environmentId: rec.environmentId, poolId: p.poolId, cellBase, inputKey: fingerprint };
            const ready = await this.d.templates.readyOfKey(key);
            if (!ready) continue;
            if (rec.sha) await this.d.templates.noteMain(key, rec.sha);
            const reason = staleReason(ready, this.d.freshness);
            if (reason && !(await this.d.templates.refreshInFlight(key, failedAfter))) stale ??= reason;
        }
        return stale;
    }
}
