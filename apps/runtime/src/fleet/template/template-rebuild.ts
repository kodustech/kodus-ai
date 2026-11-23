import type { HostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import type { DistributedLocks } from '../../shared/persistence/locks';
import { bakeFingerprintOf } from './bake-probe';
import type { SetupCandidatesReader } from './setup-candidates-store';
import type { TemplateStore } from './template-store';
import type { TemplateBuildTrigger } from './template-trigger';

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
    templates: Pick<TemplateStore, 'holds'>;
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

    private async needsBuild(rec: EnvironmentSetupRecord, pools: Array<{ poolId: string }>, now: number): Promise<boolean> {
        // A template build's own setup (bound key `template:`) is never a reason to build again.
        if (rec.state !== 'active' || rec.refSource !== 'default_branch' || rec.key.startsWith('template:')) return false;
        const fingerprint = bakeFingerprintOf(rec);
        if (!fingerprint) return false;
        const failedAfter = new Date(now - REBUILD_FAILURE_BACKOFF_MS);
        for (const p of pools) if (!(await this.d.templates.holds({ organizationId: rec.organizationId, environmentId: rec.environmentId, poolId: p.poolId, fingerprint }, failedAfter))) return true;
        return false;
    }
}
