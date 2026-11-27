import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';
import { ProviderError } from '@libs/runtime/fleet/provider-error';

import { InMemoryTemplateStore } from '../testing';
import { buildEnvironmentTemplate, type SetupHostPort } from './build-template';
import { templateNameOf } from './template-name';

const FP = 'a'.repeat(64);
const pool = parseHostPool({
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'boat',
    lifecycle: 'perRun',
    admission: { allowOrgs: ['org-kodus'] },
    hostClass: { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large' } },
});

/** A setup host that boots, bakes the default branch and seals as told. */
class FakeSetupHosts implements SetupHostPort {
    readonly booted: string[] = [];
    readonly sealed: string[] = [];
    readonly destroyed: string[] = [];
    readonly events: string[] = [];
    /** What each setup host was created from, in order. */
    readonly from: string[] = [];
    bake: { ok: true; fingerprint: string; ref: 'default_branch'; sha?: string } | { ok: false; reason: string } = { ok: true, fingerprint: FP, ref: 'default_branch' };
    constructor(private readonly provider: FakeHostProvider) {}
    async boot(req: { hostId: string; base: string; from?: string }) {
        this.booted.push(req.hostId);
        this.from.push(req.from ?? req.base);
        const h = await this.provider.create({ hostId: req.hostId, clientToken: req.hostId, cls: pool.hostClass, from: req.from ?? req.base, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags: { installation: 'it', pool: 'boat-eu-perrun', host: req.hostId } });
        return { providerId: h.providerId, source: req.from ? ('template' as const) : ('base' as const) };
    }
    async waitForBake() {
        return this.bake;
    }
    async seal(hostId: string) {
        this.sealed.push(hostId);
    }
    async destroy(hostId: string) {
        this.destroyed.push(hostId);
        this.events.push('destroy');
    }
}

const BASE = 'kodus-cell-r42-kit7';

function world() {
    const provider = new FakeHostProvider({ installation: 'it' });
    const store = new InMemoryTemplateStore();
    const hosts = new FakeSetupHosts(provider);
    const deps = { store, provider, setupHosts: hosts, cellBase: BASE, poll: { sleep: async () => undefined, attempts: 5 } };
    const req = { organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', pool, fingerprint: FP };
    return { provider, store, hosts, deps, req };
}

describe('the environment template step (boat profile, docs/runtime/host-providers.md §8.2)', () => {
    it("bakes the default branch on a setup host, seals it, saves it under the environment's name, records it, and destroys the setup host", async () => {
        const w = world();
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        const name = templateNameOf('org-kodus', 'env-shop', FP, BASE);
        expect(r).toEqual({ ok: true, name, reused: false, source: 'base' });
        expect(w.provider.savedImages.get(name)?.state).toBe('ready');
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBe(name);
        expect(w.hosts.sealed).toEqual(w.hosts.booted);
        expect(w.hosts.destroyed).toEqual(w.hosts.booted);
    });

    it("replaces the environment's older template: the new one is the one Runs start from, the old snapshot is deleted", async () => {
        const w = world();
        const old = 'b'.repeat(64);
        w.hosts.bake = { ok: true, fingerprint: old, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: old }, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBe(templateNameOf('org-kodus', 'env-shop', FP, BASE));
        expect(w.provider.savedImages.has(templateNameOf('org-kodus', 'env-shop', old, BASE))).toBe(false);
        expect(w.store.rows.find((t) => t.fingerprint === old)?.state).toBe('replaced');
    });

    it('a pool moved to a new cell base builds the template again on it and deletes the old disk, which held the old cell', async () => {
        const w = world();
        await buildEnvironmentTemplate(w.req, w.deps);
        const next = { ...w.deps, cellBase: 'kodus-cell-r43-kit7' };
        const r = await buildEnvironmentTemplate(w.req, next);
        expect(r).toEqual({ ok: true, name: templateNameOf('org-kodus', 'env-shop', FP, 'kodus-cell-r43-kit7'), reused: false, source: 'base' });
        expect(w.hosts.booted).toHaveLength(2);
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', 'kodus-cell-r43-kit7')).toBe(templateNameOf('org-kodus', 'env-shop', FP, 'kodus-cell-r43-kit7'));
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBeNull();
        expect(w.provider.savedImages.has(templateNameOf('org-kodus', 'env-shop', FP, BASE))).toBe(false);
    });

    it('a template of the same build already ready is reused: no setup host', async () => {
        const w = world();
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toEqual({ ok: true, name: templateNameOf('org-kodus', 'env-shop', FP, BASE), reused: true });
        expect(w.hosts.booted).toHaveLength(1);
    });

    it("refuses an org the pool does not admit before any host: customer data at rest in boat waits for legal", async () => {
        const w = world();
        expect(await buildEnvironmentTemplate({ ...w.req, organizationId: 'org-acme' }, w.deps)).toEqual({ ok: false, reason: 'org_not_admitted' });
        expect(w.hosts.booted).toEqual([]);
    });

    it('a bake of anything but the default branch, or of another build, saves nothing and still destroys the setup host', async () => {
        for (const bake of [{ ok: true as const, fingerprint: FP, ref: 'pull_request' as unknown as 'default_branch' }, { ok: true as const, fingerprint: 'c'.repeat(64), ref: 'default_branch' as const }]) {
            const w = world();
            w.hosts.bake = bake;
            const r = await buildEnvironmentTemplate(w.req, w.deps);
            expect(r.ok).toBe(false);
            expect(w.provider.savedImages.size).toBe(0);
            expect(w.hosts.sealed).toEqual([]);
            expect(w.hosts.destroyed).toEqual(w.hosts.booted);
            expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBeNull();
        }
    });

    it('a save that fails keeps the older template', async () => {
        const w = world();
        const old = 'b'.repeat(64);
        w.hosts.bake = { ok: true, fingerprint: old, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: old }, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        w.provider.images.save = async ({ name }) => ({ name, state: 'failed' });
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toEqual({ ok: false, reason: 'save_failed', source: 'template' });
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBe(templateNameOf('org-kodus', 'env-shop', old, BASE));
    });

    it("the template's name fits boat's saved-snapshot names and keeps the org's id out of it", () => {
        const name = templateNameOf('org-with-a-very-long-identifier-0000000000000000', 'env-with-a-long-id-11111111', FP);
        expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
        expect(name.startsWith('kodus-env-')).toBe(true);
        expect(name).not.toContain('org-with');
        expect(templateNameOf('a', 'e', FP)).not.toBe(templateNameOf('b', 'e', FP));
        // A new cell base is a new disk, under its own name, still a boat name.
        const based = templateNameOf('org-with-a-very-long-identifier-0000000000000000', 'env-with-a-long-id-11111111', FP, 'kodus-cell-dev-473818b5e-gvisor-v10');
        expect(based).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
        expect(based).not.toBe(templateNameOf('org-with-a-very-long-identifier-0000000000000000', 'env-with-a-long-id-11111111', FP, 'kodus-cell-dev-99e21eb85-gvisor-v9'));
    });

    it('a template another build is making now is left to it: no second setup host', async () => {
        const w = world();
        await w.store.begin({ organizationId: w.req.organizationId, environmentId: w.req.environmentId, poolId: w.req.poolId, fingerprint: FP, name: templateNameOf(w.req.organizationId, w.req.environmentId, FP, BASE), cellBase: BASE, setupHostId: 'tpl-other' });
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(r).toEqual({ ok: false, reason: 'already_building' });
        expect(w.hosts.booted).toEqual([]);
        expect(w.store.rows.map((x) => [x.state, x.setupHostId])).toEqual([['building', 'tpl-other']]);
    });

    it('records the setup host on the template before the host exists, so no orphan pass destroys it while it builds', async () => {
        const w = world();
        let recordedBeforeBoot: string | undefined;
        const boot = w.hosts.boot.bind(w.hosts);
        w.hosts.boot = async (req: { hostId: string; base: string; from?: string }) => {
            recordedBeforeBoot = w.store.rows[0]?.setupHostId;
            return boot(req);
        };
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(recordedBeforeBoot).toBe(w.hosts.booted[0]);
    });

    it('a retry of a failed template boots a setup host of its own: the hub never enrolls a host id twice', async () => {
        const w = world();
        w.hosts.bake = { ok: false, reason: 'bake_failed' };
        await buildEnvironmentTemplate(w.req, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.booted).toHaveLength(2);
        expect(new Set(w.hosts.booted).size).toBe(2);
        for (const id of w.hosts.booted) expect(id).toMatch(/^tpl-[a-z0-9-]{1,60}$/);
    });

    it('records why the provider failed (its code, never its message) on the failed template, and still destroys the setup host', async () => {
        const w = world();
        w.hosts.boot = async (req: { hostId: string; base: string; from?: string }) => {
            w.hosts.booted.push(req.hostId);
            throw new ProviderError('capacity_unavailable', 'no_ready_machine');
        };
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(r).toEqual({ ok: false, reason: 'build_error', cause: 'no_ready_machine' });
        expect(w.store.rows.map((x) => [x.state, x.failure])).toEqual([['failed', 'build_error:no_ready_machine']]);
        expect(w.hosts.destroyed).toEqual(w.hosts.booted);
    });

    it('records the template failed, not building, when the seal throws, and still destroys the setup host', async () => {
        const w = world();
        w.hosts.seal = async () => {
            throw new Error('seal exploded');
        };
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        // A free message is never stored: it may carry provider or host detail.
        expect(r).toEqual({ ok: false, reason: 'build_error', cause: 'unexpected', source: 'base' });
        expect(w.store.rows.map((x) => x.state)).toEqual(['failed']);
        expect(w.hosts.destroyed).toEqual(w.hosts.booted);
    });
});

describe('a template build starts from the environment\'s previous ready template', () => {
    const OLD = 'b'.repeat(64);
    const oldName = templateNameOf('org-kodus', 'env-shop', OLD, BASE);
    /** The environment's first template is ready (built cold); the next build is for FP. */
    async function withOldTemplate() {
        const w = world();
        w.hosts.bake = { ok: true, fingerprint: OLD, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: OLD }, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        w.hosts.from.length = 0;
        w.hosts.events.length = 0;
        return w;
    }

    it('creates the setup host from that template, so the build cache and the image layers are already on its disk, and says so', async () => {
        const w = await withOldTemplate();
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.from).toEqual([oldName]);
        expect(r).toEqual({ ok: true, name: templateNameOf('org-kodus', 'env-shop', FP, BASE), reused: false, source: 'template' });
    });

    it('starts from the cell base when the environment has no ready template yet', async () => {
        const w = world();
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.from).toEqual([BASE]);
        expect(r).toMatchObject({ ok: true, source: 'base' });
    });

    it('starts from the cell base when the previous template holds the cell of another base: its disk would boot the old cell', async () => {
        const w = await withOldTemplate();
        const next = 'kodus-cell-r43-kit7';
        const r = await buildEnvironmentTemplate(w.req, { ...w.deps, cellBase: next });
        expect(w.hosts.from).toEqual([next]);
        expect(r).toMatchObject({ ok: true, source: 'base' });
    });

    it('starts from the cell base when the previous template is gone at the provider', async () => {
        const w = await withOldTemplate();
        w.provider.savedImages.delete(oldName);
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.from).toEqual([BASE]);
        expect(r).toMatchObject({ ok: true, source: 'base' });
    });

    it("deletes the previous template's snapshot only after the new one is ready and the setup host created from it is destroyed", async () => {
        const w = await withOldTemplate();
        const remove = w.provider.images.remove.bind(w.provider.images);
        w.provider.images.remove = async (name) => (w.hosts.events.push(`remove:${name}`), remove(name));
        const save = w.provider.images.save.bind(w.provider.images);
        w.provider.images.save = async (r) => (w.hosts.events.push(`save:${r.name}`), save(r));
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.events).toEqual([`save:${templateNameOf('org-kodus', 'env-shop', FP, BASE)}`, 'destroy', `remove:${oldName}`]);
    });

    it('keeps the previous template, source snapshot included, when the build from it fails', async () => {
        const w = await withOldTemplate();
        w.hosts.bake = { ok: false, reason: 'bake_failed' };
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(r).toMatchObject({ ok: false, reason: 'bake_failed', source: 'template' });
        expect(w.provider.savedImages.has(oldName)).toBe(true);
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBe(oldName);
    });
    it('after a failed build that started from the template, the next attempt starts from the cell base: a bad template never blocks rebuilds', async () => {
        const w = await withOldTemplate();
        w.hosts.bake = { ok: false, reason: 'bake_failed' };
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toMatchObject({ ok: false, source: 'template' });
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.from).toEqual([oldName, BASE]);
        expect(r).toMatchObject({ ok: true, source: 'base' });
    });

    it('also for a build that failed on another fingerprint, and for every failure after the host was made', async () => {
        const w = await withOldTemplate();
        w.hosts.seal = async () => {
            throw new Error('seal exploded');
        };
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toMatchObject({ ok: false, reason: 'build_error', source: 'template' });
        const other = 'c'.repeat(64);
        w.hosts.bake = { ok: true, fingerprint: other, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: other }, w.deps);
        expect(w.hosts.from).toEqual([oldName, BASE]);
    });

    it('after a failed build that started from the cell base, the next attempt may use the template again', async () => {
        const w = await withOldTemplate();
        // The template is unusable as a source once for this build only if a template-sourced build failed; a base failure says nothing about it.
        w.provider.savedImages.delete(oldName);
        w.hosts.bake = { ok: false, reason: 'bake_failed' };
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toMatchObject({ ok: false, source: 'base' });
        w.provider.savedImages.set(oldName, { name: oldName, state: 'ready' });
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.hosts.from).toEqual([BASE, oldName]);
    });

    it('a template-sourced failure is forgotten once a later build succeeds', async () => {
        const w = await withOldTemplate();
        w.hosts.bake = { ok: false, reason: 'bake_failed' };
        await buildEnvironmentTemplate(w.req, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        await buildEnvironmentTemplate(w.req, w.deps);
        const third = 'd'.repeat(64);
        w.hosts.bake = { ok: true, fingerprint: third, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: third }, w.deps);
        expect(w.hosts.from).toEqual([oldName, BASE, templateNameOf('org-kodus', 'env-shop', FP, BASE)]);
    });
});

// docs/runtime/host-providers.md §8.2.2: a freshness rebuild of an unchanged key.
describe('the environment template step, rebuilding an unchanged key for freshness', () => {
    it('builds beside the ready template: it keeps serving while the rebuild runs, then the rebuild replaces it and the older snapshot is deleted', async () => {
        const w = world();
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch', sha: '1'.repeat(40) };
        await buildEnvironmentTemplate(w.req, w.deps);
        const first = templateNameOf('org-kodus', 'env-shop', FP, BASE);
        const refreshFp = 'f'.repeat(64);
        const second = templateNameOf('org-kodus', 'env-shop', refreshFp, BASE);
        let servedDuring: string | null = null;
        const waitForBake = w.hosts.waitForBake.bind(w.hosts);
        w.hosts.waitForBake = async () => {
            servedDuring = await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE);
            return { ok: true, fingerprint: FP, ref: 'default_branch', sha: '2'.repeat(40) } as Awaited<ReturnType<typeof waitForBake>>;
        };
        const r = await buildEnvironmentTemplate({ ...w.req, fingerprint: refreshFp, inputKey: FP }, w.deps);
        expect(r).toMatchObject({ ok: true, name: second, reused: false });
        expect(servedDuring).toBe(first);
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun', BASE)).toBe(second);
        expect(w.provider.savedImages.get(first)).toBeUndefined();
        // The rebuild starts from the ready template, so its cache and images are on the disk.
        expect(w.hosts.from.at(-1)).toBe(first);
    });
    it("checks the bake against the key, not the rebuild's own fingerprint", async () => {
        const w = world();
        w.hosts.bake = { ok: true, fingerprint: 'b'.repeat(64), ref: 'default_branch' };
        const r = await buildEnvironmentTemplate({ ...w.req, fingerprint: 'f'.repeat(64), inputKey: FP }, w.deps);
        expect(r).toMatchObject({ ok: false, reason: 'fingerprint_mismatch' });
    });
    it('records the main commit the template setup booted when the template turns ready', async () => {
        const w = world();
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch', sha: '3'.repeat(40) };
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(w.store.rows[0].mainSha).toBe('3'.repeat(40));
        expect(w.store.rows[0].inputKey).toBe(FP);
    });
});

