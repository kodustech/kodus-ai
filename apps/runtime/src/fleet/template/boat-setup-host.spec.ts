import { FakeHostProvider } from '@libs/runtime/fleet/fake-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';
import { boundKeyOfTemplate } from '@libs/runtime/placement/candidate-pools';

import { InMemoryTemplateStore } from '../testing';
import { BoatSetupHost, type BakeProbe, type HostSealer } from './boat-setup-host';
import { buildEnvironmentTemplate } from './build-template';
import { templateNameOf } from './template-name';

const FP = 'b'.repeat(64);
const pool = parseHostPool({
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'boat',
    lifecycle: 'perRun',
    admission: { allowOrgs: ['org-kodus'] },
    hostClass: { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large' } },
});

function world(probe: BakeProbe['read'] = async () => ({ state: 'done', fingerprint: FP, ref: 'default_branch' })) {
    const provider = new FakeHostProvider({ installation: 'it', startState: 'running' });
    const minted: Array<{ hostId: string; poolId: string; boundKey: string | null }> = [];
    const retired: string[] = [];
    const sealed: string[] = [];
    const hub = {
        mint: async (r: { hostId: string; poolId: string; boundKey: string | null; ttlSeconds: number }) => (minted.push(r), { ok: true as const, token: 'kcf_x' }),
        retire: async (id: string) => void retired.push(id),
    };
    const sealer: HostSealer = { seal: async (r) => void sealed.push(r.providerId) };
    const host = new BoatSetupHost({ provider, hub, probe: { read: probe }, sealer, poolOf: async (id) => (id === 'boat-eu-perrun' ? pool : undefined), installation: 'it', bootstrap: { hubUrl: 'h', hubCa: 'c' }, poll: { sleep: async () => undefined, attempts: 3 } });
    const store = new InMemoryTemplateStore();
    const req = { organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', pool, fingerprint: FP };
    return { provider, minted, retired, sealed, host, store, req };
}

describe('the live setup host on boat (docs/runtime/host-providers.md §8.2)', () => {
    it("boots from the cell base with a token bound to the template's environment, not to a Run", async () => {
        const w = world();
        const { providerId } = await w.host.boot({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', fingerprint: 'a'.repeat(64), base: 'kodus-cell-r42-kit7' });
        expect(w.minted).toEqual([{ hostId: 'tpl-1', poolId: 'boat-eu-perrun', boundKey: boundKeyOfTemplate('org-kodus', 'env-shop'), ttlSeconds: expect.any(Number) }]);
        expect(w.provider.hosts.get(providerId)?.from).toBe('kodus-cell-r42-kit7');
        expect(w.provider.hosts.get(providerId)?.tags).toEqual({ installation: 'it', pool: 'boat-eu-perrun', host: 'tpl-1' });
    });

    it('waits for a machine instead of failing fast when none is ready: the template build runs in the background, no Run waits on it', async () => {
        const w = world();
        const classes: unknown[] = [];
        const create = w.provider.create.bind(w.provider);
        w.provider.create = async (req) => (classes.push(req.cls), create(req));
        await w.host.boot({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', fingerprint: 'a'.repeat(64), base: 'b' });
        expect(classes).toEqual([expect.objectContaining({ provider: 'boat', boat: expect.objectContaining({ type: 'large', failFast: false }) })]);
        expect(pool.hostClass).toMatchObject({ boat: { failFast: true } });
    });

    it('refuses to boot when the hub refuses the token, and creates nothing', async () => {
        const w = world();
        (w.host as any).deps.hub.mint = async () => ({ ok: false, reason: 'unknown_pool' });
        await expect(w.host.boot({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', fingerprint: 'a'.repeat(64), base: 'b' })).rejects.toThrow('token_refused');
        expect(w.provider.hosts.size).toBe(0);
    });

    it('waits while the setup runs, then reports the fingerprint and ref it baked', async () => {
        const answers = [{ state: 'running' }, { state: 'running' }, { state: 'done', fingerprint: FP, ref: 'default_branch' }] as const;
        let i = 0;
        const w = world(async () => answers[i++]);
        expect(await w.host.waitForBake({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop' })).toEqual({ ok: true, fingerprint: FP, ref: 'default_branch' });
    });

    it('reports a failed setup and a setup that never finishes as failed bakes', async () => {
        expect(await world(async () => ({ state: 'failed', reason: 'recipe_failed' })).host.waitForBake({ hostId: 'h', organizationId: 'o', environmentId: 'e' })).toEqual({ ok: false, reason: 'recipe_failed' });
        expect(await world(async () => ({ state: 'running' })).host.waitForBake({ hostId: 'h', organizationId: 'o', environmentId: 'e' })).toEqual({ ok: false, reason: 'bake_timeout' });
    });

    it('seals through the sealer on that provider host, then retires the cell identity at the hub', async () => {
        const w = world();
        const { providerId } = await w.host.boot({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', fingerprint: 'a'.repeat(64), base: 'b' });
        await w.host.seal('tpl-1');
        expect(w.sealed).toEqual([providerId]);
        expect(w.retired).toEqual(['tpl-1']);
    });

    it('destroys the provider host and retires the cell, also after a restart (host found by its tag)', async () => {
        const w = world();
        const { providerId } = await w.host.boot({ hostId: 'tpl-1', organizationId: 'org-kodus', environmentId: 'env-shop', poolId: 'boat-eu-perrun', fingerprint: 'a'.repeat(64), base: 'b' });
        (w.host as any).providerIds.clear();
        await w.host.destroy('tpl-1');
        expect((await w.provider.get(providerId))?.state ?? 'gone').toBe('gone');
        expect(w.retired).toContain('tpl-1');
    });

    it('runs the whole template workflow: ready template named for the environment, setup host destroyed', async () => {
        const w = world();
        const r = await buildEnvironmentTemplate(w.req, { store: w.store, provider: w.provider, setupHosts: w.host, cellBase: 'kodus-cell-r42-kit7', poll: { sleep: async () => undefined, attempts: 5 } });
        expect(r).toEqual({ ok: true, name: templateNameOf('org-kodus', 'env-shop', FP), reused: false });
        expect(await w.store.readyName('org-kodus', 'env-shop', 'boat-eu-perrun')).toBe(r.ok ? r.name : '');
        expect([...w.provider.hosts.values()].every((h) => h.state === 'gone')).toBe(true);
    });
});
