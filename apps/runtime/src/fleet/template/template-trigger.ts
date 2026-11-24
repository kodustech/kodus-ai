import type { HostPool } from '@libs/runtime/fleet/pool';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import type { TemplateResolver } from '../per-run-host';
import { bakeFingerprintOf, templateSetupCommandKey } from './bake-probe';
import type { BuildTemplateRequest, BuildTemplateResult, SetupHostPort } from './build-template';
import type { TemplateStore } from './template-store';

// When an environment's template gets built (docs/runtime/host-providers.md §8.2): (a) a perRun boat pool has
// demand for a Run whose environment has no ready template, without blocking that Run (it boots from the cell
// base meanwhile); (b) an environment's setup finishes on the default branch with a new fingerprint. At most one
// build per environment at a time (this process; the template row's `building` state is the durable mark).

export interface TemplateSetupRequester {
    /** Asks the existing setup request path for the environment's setup, bound to its template host (`boundKey`), under `key`. */
    request(req: { organizationId: string; environmentId: string; poolId: string; fingerprint: string; key: string; boundKey: string }): Promise<void>;
}

/**
 * Records that an environment's main commit wants a baseline suite run (docs/runtime/e2e-suites.md section 2.1). The
 * fleet process holds no repository credentials, so it cannot produce the command itself: the product reads the
 * recorded requests and issues `RuntimeSuiteRequested`, as it does for a template's setup.
 */
export interface SuiteBaselineRequester {
    request(req: { organizationId: string; environmentId: string; repositoryId: string; mainSha: string; fingerprint: string }): Promise<void>;
}

export interface TemplateTriggerDeps {
    store: Pick<TemplateStore, 'find' | 'readyName'>;
    /** The environment's own latest setup, by environment id (runtime_environment_setups); never a template build's setup record. */
    environmentSetups: { get(environmentId: string): Promise<EnvironmentSetupRecord | null> };
    /** The pool a Run's demand is on. */
    poolOf(poolId: string): Promise<{ poolId: string; pool: HostPool } | null>;
    /** The boat perRun pools that may build templates for the org. */
    boatPoolsOf(organizationId: string): Promise<Array<{ poolId: string; pool: HostPool }>>;
    build(req: BuildTemplateRequest): Promise<BuildTemplateResult>;
    /** Absent: no baseline is asked for when a template turns ready. */
    baselines?: SuiteBaselineRequester;
    log?(msg: string, fields: Record<string, unknown>): void;
}

/** The environment's own recipe declares a suite whose baseline is not turned off (`suite.baseline: false`); a recipe that does not parse declares none. */
function wantsBaseline(rec: EnvironmentSetupRecord): boolean {
    const content = rec.recipe?.content;
    if (!content) return false;
    const parsed = parseRecipe(content);
    return parsed.ok && !!parsed.recipe.suite && parsed.recipe.suite.baseline !== false;
}

export class TemplateBuildTrigger {
    private readonly inflight = new Set<string>();

    constructor(private readonly d: TemplateTriggerDeps) {}

    /** A Run's host is being made on `poolId`: start the environment's build when it has no ready template. Never throws, never waits for the build. */
    async onDemand(req: { organizationId: string; environmentId: string | null; poolId: string; provider: string }): Promise<void> {
        if (!req.environmentId || req.provider !== 'boat') return;
        try {
            if (await this.d.store.readyName(req.organizationId, req.environmentId, req.poolId)) return;
            const stored = await this.d.poolOf(req.poolId);
            if (stored) await this.start(req.organizationId, req.environmentId, stored.poolId, stored.pool);
        } catch (e) {
            this.d.log?.('template.trigger_failed', { environmentId: req.environmentId, error: (e as Error).message });
        }
    }

    /** An environment's setup finished: when it is active on the default branch with a fingerprint no template holds yet, build it on every boat pool. */
    async onSetupFinished(rec: EnvironmentSetupRecord): Promise<void> {
        try {
            if (rec.state !== 'active' || rec.refSource !== 'default_branch') return;
            for (const p of await this.d.boatPoolsOf(rec.organizationId)) await this.start(rec.organizationId, rec.environmentId, p.poolId, p.pool);
        } catch (e) {
            this.d.log?.('template.trigger_failed', { environmentId: rec.environmentId, error: (e as Error).message });
        }
    }

    private async requestBaseline(req: Parameters<SuiteBaselineRequester['request']>[0]): Promise<void> {
        if (!this.d.baselines) return;
        try {
            await this.d.baselines.request(req);
        } catch (e) {
            // The template stays; the next main commit asks again.
            this.d.log?.('template.baseline_request_failed', { environmentId: req.environmentId, error: (e as Error).message });
        }
    }

    private async start(organizationId: string, environmentId: string, poolId: string, pool: HostPool): Promise<void> {
        const key = `${organizationId}/${environmentId}`;
        if (this.inflight.has(key)) return;
        const rec = await this.d.environmentSetups.get(environmentId);
        // Only what the environment's active default-branch setup baked can be templated.
        if (!rec || rec.organizationId !== organizationId || rec.state !== 'active' || rec.refSource !== 'default_branch') return;
        const fingerprint = bakeFingerprintOf(rec);
        if (!fingerprint || (await this.d.store.find(organizationId, environmentId, poolId, fingerprint))?.state === 'ready') return;
        this.inflight.add(key);
        void this.d
            .build({ organizationId, environmentId, poolId, pool, fingerprint })
            .then(async (r) => {
                this.d.log?.('template.built', { environmentId, poolId, ok: r.ok, ...(r.ok === false ? { reason: r.reason, ...(r.cause ? { cause: r.cause } : {}) } : {}) });
                // A template that turned ready now (not one that was already there) holds a main commit nobody ran the suite on.
                if (r.ok && !r.reused && rec.sha && wantsBaseline(rec)) await this.requestBaseline({ organizationId, environmentId, repositoryId: rec.repositoryId, mainSha: rec.sha, fingerprint });
            })
            .catch((e) => this.d.log?.('template.build_error', { environmentId, poolId, error: (e as Error).message }))
            .finally(() => this.inflight.delete(key));
    }
}

/** What a Run host starts from, and the build trigger on a miss: the Run never waits for the template. */
export class TriggeringTemplateResolver implements TemplateResolver {
    constructor(
        private readonly inner: TemplateResolver,
        private readonly trigger: Pick<TemplateBuildTrigger, 'onDemand'>,
    ) {}

    async resolve(req: { organizationId: string; environmentId: string | null; poolId: string; provider: string }) {
        const name = await this.inner.resolve(req);
        if (!name) void this.trigger.onDemand(req);
        return name;
    }
}

/** The setup host port that, once the host is booted, asks for the environment's setup on it through the setup request path. */
export class RequestingSetupHost implements SetupHostPort {
    constructor(
        private readonly inner: SetupHostPort,
        private readonly requester: TemplateSetupRequester,
    ) {}

    async boot(req: Parameters<SetupHostPort['boot']>[0]) {
        const host = await this.inner.boot(req);
        // The hub holds the claim until the template cell registers (no cell yet is a retryable wait).
        await this.requester.request({ organizationId: req.organizationId, environmentId: req.environmentId, poolId: req.poolId, fingerprint: req.fingerprint, key: templateSetupCommandKey(req.organizationId, req.environmentId, req.hostId), boundKey: `template:${req.organizationId}/${req.environmentId}` });
        return host;
    }
    waitForBake(req: Parameters<SetupHostPort['waitForBake']>[0]) {
        return this.inner.waitForBake(req);
    }
    seal(hostId: string) {
        return this.inner.seal(hostId);
    }
    destroy(hostId: string) {
        return this.inner.destroy(hostId);
    }
}
