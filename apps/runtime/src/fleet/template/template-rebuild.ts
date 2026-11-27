import { cellBaseOf, type HostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import type { DistributedLocks } from '../../shared/persistence/locks';
import { bakeFingerprintOf } from './bake-probe';
import type { SetupCandidatesReader } from './setup-candidates-store';
import type { TemplateStore } from './template-store';
import type { TemplateBuildTrigger } from './template-trigger';
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

export interface TemplateRebuildDeps {
    setups: SetupCandidatesReader;
    templates: Pick<TemplateStore, 'holds' | 'building' | 'failStale'>;
    /** The setup host ids the provider lists as alive; null when it could not be asked. Absent: the watchdog never judges by the host. */
    liveSetupHosts?(): Promise<Set<string> | null>;
    /** The boat perRun pools of the fleet, with the orgs each admits. */
    boatPools(): Promise<Array<{ poolId: string; pool: HostPool }>>;
    trigger: Pick<TemplateBuildTrigger, 'onSetupFinished'>;
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
            if (!(await this.needsBuild(rec, pools.filter((p) => admitted(p, rec.organizationId)), now))) continue;
            triggered++;
            await this.d.trigger.onSetupFinished(rec);
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

    private async needsBuild(rec: EnvironmentSetupRecord, pools: Array<{ poolId: string; pool: HostPool }>, now: number): Promise<boolean> {
        // A template build's own setup (bound key `template:`) is never a reason to build again.
        if (rec.state !== 'active' || rec.refSource !== 'default_branch' || rec.key.startsWith('template:')) return false;
        const fingerprint = bakeFingerprintOf(rec);
        if (!fingerprint) return false;
        const failedAfter = new Date(now - REBUILD_FAILURE_BACKOFF_MS);
        // A template of the pool's former cell base holds nothing: the pool moved to a new cell, and the template is built again on it.
        for (const p of pools)
            if (!(await this.d.templates.holds({ organizationId: rec.organizationId, environmentId: rec.environmentId, poolId: p.poolId, fingerprint, cellBase: cellBaseOf(p.pool.hostClass) ?? '' }, failedAfter))) return true;
        return false;
    }
}
