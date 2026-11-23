import { parseHostPool } from '@libs/runtime/fleet/pool';
import { FakeHostProvider } from '@libs/runtime/fleet/testing';

import { fleetHostId } from './fleet-store';
import type { PerRunHostInput } from './per-run-host';
import { reconcileOnce, type ReconcileDeps } from './reconcile';
import { FakeClock, InMemoryFleetStore } from './testing';

const perRun = parseHostPool({
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'fake',
    lifecycle: 'perRun',
    hostClass: { kind: 'HostClass', name: 'fake', provider: 'fake' },
    health: { maxConsecutiveFailures: 3 },
});

function world() {
    const clock = new FakeClock();
    const store = new InMemoryFleetStore(clock);
    const poolId = store.addPool(perRun);
    const provider = new FakeHostProvider({ installation: 'it', startState: 'running' });
    const started: PerRunHostInput[] = [];
    const deps: ReconcileDeps = {
        store,
        // As the workflow does first: the host row, so a later pass sees the host on its way.
        start: async (input) => {
            started.push(input);
            await store.insertHost({ hostId: input.hostId, poolId: input.poolId, provider: 'fake', boundKey: input.boundKey, organizationId: input.organizationId });
        },
        providerFor: (k) => (k === 'fake' ? provider : undefined),
        installation: 'it',
        now: clock.now,
        log: () => undefined,
    };
    return { clock, store, poolId, provider, started, deps };
}

describe('the fleet reconcile pass', () => {
    it('starts one host workflow per waiting Run, once, whichever replica sees the demand first', async () => {
        const w = world();
        w.store.addDemand({ poolId: w.poolId, boundKey: 'run:org-a/r-1', organizationId: 'org-a', environmentId: 'env-1', runId: 'r-1' });
        await reconcileOnce(w.deps);
        await reconcileOnce(w.deps);
        expect(w.started).toEqual([{ hostId: fleetHostId(w.poolId, 'run:org-a/r-1'), poolId: w.poolId, boundKey: 'run:org-a/r-1', organizationId: 'org-a', environmentId: 'env-1' }]);
        expect(w.store.pools.get(w.poolId)!.status.scalable).toBe(true);
    });

    it('a pool whose last hosts failed in a row stops taking Runs until its cooldown ends, then tries one again', async () => {
        const w = world();
        for (let i = 0; i < 3; i++) await w.store.recordPoolOutcome(w.poolId, { ok: false, reason: 'registration_timeout' });
        w.store.addDemand({ poolId: w.poolId, boundKey: 'run:org-a/r-2', organizationId: 'org-a', environmentId: null, runId: 'r-2' });
        await reconcileOnce(w.deps);
        expect(w.store.pools.get(w.poolId)!.status).toMatchObject({ scalable: false, reason: 'breaker_open' });
        expect(w.started).toEqual([]);
        w.clock.t += 5 * 60_000 + 1;
        w.store.addDemand({ poolId: w.poolId, boundKey: 'run:org-a/r-2', organizationId: 'org-a', environmentId: null, runId: 'r-2' });
        await reconcileOnce(w.deps);
        expect(w.store.pools.get(w.poolId)!.status.scalable).toBe(true);
        expect(w.started).toHaveLength(1);
    });

    it("destroys a provider host of this installation that no live host row names, keeps the ones that do, and never touches another installation's", async () => {
        const w = world();
        const tags = (host: string) => ({ installation: 'it', pool: w.poolId, host });
        const orphan = await w.provider.create({ hostId: 'host-lost', clientToken: 'host-lost', cls: perRun.hostClass, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags: tags('host-lost') });
        const live = await w.provider.create({ hostId: 'host-live', clientToken: 'host-live', cls: perRun.hostClass, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags: tags('host-live') });
        await w.store.insertHost({ hostId: 'host-live', poolId: w.poolId, provider: 'fake', boundKey: 'run:org-a/r-3', organizationId: 'org-a' });
        const foreign = w.provider.addForeign();
        const r = await reconcileOnce(w.deps, { orphans: true });
        expect(r.destroyed).toEqual([orphan.providerId]);
        expect(await w.provider.get(orphan.providerId)).toBeNull();
        expect(await w.provider.get(live.providerId)).not.toBeNull();
        expect(await w.provider.get(foreign)).not.toBeNull();
    });

    it("never destroys a template's setup host while its template builds, and destroys it as an orphan once nothing builds on it", async () => {
        const w = world();
        const building = new Set(['tpl-building']);
        w.deps.templateSetupHosts = async () => [...building];
        const tags = { installation: 'it', pool: w.poolId, host: 'tpl-building' };
        const setupHost = await w.provider.create({ hostId: 'tpl-building', clientToken: 'tpl-building', cls: perRun.hostClass, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags });
        expect((await reconcileOnce(w.deps, { orphans: true })).destroyed).toEqual([]);
        expect(await w.provider.get(setupHost.providerId)).not.toBeNull();
        building.clear();
        expect((await reconcileOnce(w.deps, { orphans: true })).destroyed).toEqual([setupHost.providerId]);
    });

    it('never destroys a host whose row and machine a workflow on another replica makes while the orphan pass runs', async () => {
        const w = world();
        const tags = { installation: 'it', pool: w.poolId, host: 'host-new' };
        // A per-host workflow writes its row, then creates the machine, right after the pass's first read.
        let made = false;
        const make = async () => {
            if (made) return;
            made = true;
            await w.store.insertHost({ hostId: 'host-new', poolId: w.poolId, provider: 'fake', boundKey: 'run:org-a/r-5', organizationId: 'org-a' });
            await w.provider.create({ hostId: 'host-new', clientToken: 'host-new', cls: perRun.hostClass, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags });
        };
        const liveHosts = w.store.liveHosts.bind(w.store);
        w.store.liveHosts = async (poolId?: string) => {
            const rows = await liveHosts(poolId);
            await make();
            return rows;
        };
        const list = w.provider.list.bind(w.provider);
        w.provider.list = async (t) => {
            await make();
            return list(t);
        };
        const r = await reconcileOnce(w.deps, { orphans: true });
        expect(made).toBe(true);
        expect(r.destroyed).toEqual([]);
        expect([...w.provider.hosts.values()].filter((h) => h.tags.host === 'host-new' && h.state !== 'gone')).toHaveLength(1);
    });

    it("a boat pool takes no Run until its cell base is a ready saved image, so placement moves Runs on instead of failing them", async () => {
        const w = world();
        const boatPool = (base?: string) => parseHostPool({ ...perRun, name: base ? 'boat-based' : 'boat-baseless', provider: 'boat', hostClass: { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', ...(base ? { base } : {}) } } });
        const based = w.store.addPool(boatPool('kodus-cell-r42-gvisor'));
        const baseless = w.store.addPool(boatPool());
        const deps = { ...w.deps, providerFor: (k: string) => (k === 'fake' || k === 'boat' ? w.provider : undefined) };
        for (const poolId of [based, baseless]) w.store.addDemand({ poolId, boundKey: `run:org-a/${poolId}`, organizationId: 'org-a', environmentId: 'env-1', runId: poolId });
        await reconcileOnce(deps);
        expect(w.store.pools.get(based)!.status).toMatchObject({ scalable: false, reason: 'base_missing' });
        expect(w.store.pools.get(baseless)!.status).toMatchObject({ scalable: false, reason: 'base_missing' });
        expect(w.started).toEqual([]);
        w.provider.savedImages.set('kodus-cell-r42-gvisor', { name: 'kodus-cell-r42-gvisor', state: 'ready' });
        await reconcileOnce(deps);
        expect(w.store.pools.get(based)!.status.scalable).toBe(true);
        expect(w.started.map((s) => s.poolId)).toEqual([based]);
    });

    it('leaves a pooled pool alone: its loop is not built', async () => {
        const w = world();
        const pooledId = w.store.addPool(parseHostPool({ ...perRun, name: 'aws-later', lifecycle: 'pooled', capacity: { min: 0, max: 2, warm: 1 } }));
        w.store.addDemand({ poolId: pooledId, boundKey: 'run:org-a/r-4', organizationId: 'org-a', environmentId: null, runId: 'r-4' });
        await reconcileOnce(w.deps);
        expect(w.started).toEqual([]);
        expect(w.store.pools.get(pooledId)!.status).toMatchObject({ scalable: false, reason: 'lifecycle_not_built' });
    });
});
