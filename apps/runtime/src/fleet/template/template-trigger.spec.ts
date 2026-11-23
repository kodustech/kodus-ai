import { parseHostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { InMemoryTemplateStore } from '../testing';
import { RequestingSetupHost, TemplateBuildTrigger, TriggeringTemplateResolver } from './template-trigger';

const FP = 'c'.repeat(64);
const pool = parseHostPool({ kind: 'HostPool', name: 'boat-perrun', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'c', provider: 'boat', boat: { type: 'large' } } });
const record = (over: Partial<EnvironmentSetupRecord> = {}) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: 'k', state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
const demand = { organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', provider: 'boat' };

function world(rec: EnvironmentSetupRecord | null = record()) {
    const store = new InMemoryTemplateStore();
    const builds: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const trigger = new TemplateBuildTrigger({
        store,
        setups: { get: async () => rec },
        poolOf: async (poolId) => ({ poolId, pool }),
        boatPoolsOf: async () => [{ poolId: 'p', pool }],
        build: async (req) => {
            builds.push(req);
            await gate;
            return { ok: true, name: 'n', reused: false };
        },
    });
    return { store, builds, trigger, release };
}

describe('when an environment template is built', () => {
    it('starts one build, without waiting for it, when a Run has demand and the environment has no ready template', async () => {
        const w = world();
        await w.trigger.onDemand(demand);
        expect(w.builds).toEqual([expect.objectContaining({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP })]);
        w.release();
    });
    it('starts at most one build per environment at a time', async () => {
        const w = world();
        await w.trigger.onDemand(demand);
        await w.trigger.onDemand(demand);
        await w.trigger.onSetupFinished(record());
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('builds nothing when the template is ready, the environment is unknown, or the setup is not an active default-branch one', async () => {
        const ready = world();
        await ready.store.begin({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, name: 'n' });
        await ready.store.promote({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP });
        await ready.trigger.onDemand(demand);
        await ready.trigger.onSetupFinished(record());
        await world().trigger.onDemand({ ...demand, environmentId: null });
        const blocked = world(record({ state: 'blocked' }));
        await blocked.trigger.onDemand(demand);
        const override = world(record({ refSource: 'dev_override' }));
        await override.trigger.onSetupFinished(record({ refSource: 'dev_override' }));
        expect([ready.builds, blocked.builds, override.builds].flat()).toEqual([]);
    });
    it('starts a build when an environment setup finishes on the default branch with a fingerprint no template holds', async () => {
        const w = world();
        await w.trigger.onSetupFinished(record());
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('lets the Run boot from the cell base while the build starts, and never throws into it', async () => {
        const w = world();
        const resolver = new TriggeringTemplateResolver({ resolve: async () => null }, w.trigger);
        expect(await resolver.resolve(demand)).toBeNull();
        await new Promise((r) => setImmediate(r));
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('asks the setup request path for the environment bound to its template once the setup host is booted', async () => {
        const calls: string[] = [];
        const host = new RequestingSetupHost(
            { boot: async () => (calls.push('boot'), { providerId: 'pid' }), waitForBake: async () => ({ ok: false, reason: 'x' }), seal: async () => undefined, destroy: async () => undefined },
            { request: async (r) => void calls.push(`${r.boundKey}|${r.key}`) },
        );
        await host.boot({ hostId: 'tpl-1', organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, base: 'b' });
        expect(calls).toEqual(['boot', 'template:org-1/env-1|template:org-1/env-1:tpl-1']);
    });
});
