import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';

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
    bake: { ok: true; fingerprint: string; ref: 'default_branch' } | { ok: false; reason: string } = { ok: true, fingerprint: FP, ref: 'default_branch' };
    constructor(private readonly provider: FakeHostProvider) {}
    async boot(req: { hostId: string; base: string }) {
        this.booted.push(req.hostId);
        const h = await this.provider.create({ hostId: req.hostId, clientToken: req.hostId, cls: pool.hostClass, from: req.base, bootstrap: { hubUrl: 'h', hubCa: 'c', token: 't' }, tags: { installation: 'it', pool: 'boat-eu-perrun', host: req.hostId } });
        return { providerId: h.providerId };
    }
    async waitForBake() {
        return this.bake;
    }
    async seal(hostId: string) {
        this.sealed.push(hostId);
    }
    async destroy(hostId: string) {
        this.destroyed.push(hostId);
    }
}

function world() {
    const provider = new FakeHostProvider({ installation: 'it' });
    const store = new InMemoryTemplateStore();
    const hosts = new FakeSetupHosts(provider);
    const deps = { store, provider, setupHosts: hosts, cellBase: 'kodus-cell-r42-kit7', poll: { sleep: async () => undefined, attempts: 5 } };
    const req = { organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', pool, fingerprint: FP };
    return { provider, store, hosts, deps, req };
}

describe('the environment template step (boat profile, docs/runtime/host-providers.md §8.2)', () => {
    it("bakes the default branch on a setup host, seals it, saves it under the environment's name, records it, and destroys the setup host", async () => {
        const w = world();
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        const name = templateNameOf('org-kodus', 'env-shop', FP);
        expect(r).toEqual({ ok: true, name, reused: false });
        expect(w.provider.savedImages.get(name)?.state).toBe('ready');
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun')).toBe(name);
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
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun')).toBe(templateNameOf('org-kodus', 'env-shop', FP));
        expect(w.provider.savedImages.has(templateNameOf('org-kodus', 'env-shop', old))).toBe(false);
        expect(w.store.rows.find((t) => t.fingerprint === old)?.state).toBe('replaced');
    });

    it('a template of the same build already ready is reused: no setup host', async () => {
        const w = world();
        await buildEnvironmentTemplate(w.req, w.deps);
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toEqual({ ok: true, name: templateNameOf('org-kodus', 'env-shop', FP), reused: true });
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
            expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun')).toBeNull();
        }
    });

    it('a save that fails keeps the older template', async () => {
        const w = world();
        const old = 'b'.repeat(64);
        w.hosts.bake = { ok: true, fingerprint: old, ref: 'default_branch' };
        await buildEnvironmentTemplate({ ...w.req, fingerprint: old }, w.deps);
        w.hosts.bake = { ok: true, fingerprint: FP, ref: 'default_branch' };
        w.provider.images.save = async ({ name }) => ({ name, state: 'failed' });
        expect(await buildEnvironmentTemplate(w.req, w.deps)).toEqual({ ok: false, reason: 'save_failed' });
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun')).toBe(templateNameOf('org-kodus', 'env-shop', old));
    });

    it("the template's name fits boat's saved-snapshot names and keeps the org's id out of it", () => {
        const name = templateNameOf('org-with-a-very-long-identifier-0000000000000000', 'env-with-a-long-id-11111111', FP);
        expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
        expect(name.startsWith('kodus-env-')).toBe(true);
        expect(name).not.toContain('org-with');
        expect(templateNameOf('a', 'e', FP)).not.toBe(templateNameOf('b', 'e', FP));
    });

    it('records the template failed, not building, when the seal throws, and still destroys the setup host', async () => {
        const w = world();
        w.hosts.seal = async () => {
            throw new Error('seal exploded');
        };
        const r = await buildEnvironmentTemplate(w.req, w.deps);
        expect(r).toEqual({ ok: false, reason: 'build_error' });
        expect(w.store.rows.map((x) => x.state)).toEqual(['failed']);
        expect(w.hosts.destroyed).toEqual(w.hosts.booted);
    });
});
