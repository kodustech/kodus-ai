import type { HostProvider } from '@libs/runtime/fleet/host-provider';
import type { HostPool } from '@libs/runtime/fleet/pool';

import { templateNameOf } from './template-name';
import type { TemplateStore } from './template-store';

// The environment template on boat (docs/runtime/host-providers.md §8.2): a
// setup host started from the cell base boots the environment on its default
// branch only (S-52: never PR code), bakes the images and seeds the data;
// then it is sealed (cell stopped, identity, token file and /tmp removed),
// saved as kodus-env-<org-hash>-<env-hash>-<fingerprint>, recorded, and the
// environment's older template is replaced and its snapshot deleted. The
// setup host is destroyed whatever happens. The live SetupHostPort (enrolling
// the setup host, driving its setup, sealing it) waits for the boat spike.

/** The setup host's life, as runtime-fleet drives it through the hub. Not built live yet. */
export interface SetupHostPort {
    /** Starts a setup host from the cell base, enrolled with a token bound to the template. */
    boot(req: { hostId: string; organizationId: string; environmentId: string; poolId: string; base: string }): Promise<{ providerId: string }>;
    /** Waits for the environment's setup on that host; what it baked, and on which ref. */
    waitForBake(req: { hostId: string; organizationId: string; environmentId: string }): Promise<{ ok: true; fingerprint: string; ref: 'default_branch' } | { ok: false; reason: string }>;
    /** Stops the cell and removes its identity, the token file and /tmp, so the saved disk holds none. */
    seal(hostId: string): Promise<void>;
    destroy(hostId: string): Promise<void>;
}

export interface BuildTemplateDeps {
    store: TemplateStore;
    provider: HostProvider;
    setupHosts: SetupHostPort;
    /** The saved snapshot of the cell release and kit setup hosts start from (kodus-cell-<release>-<kit>). */
    cellBase: string;
    poll: { sleep(ms: number): Promise<void>; attempts: number; intervalMs?: number };
}

export interface BuildTemplateRequest {
    organizationId: string;
    environmentId: string;
    poolId: string;
    pool: HostPool;
    /** The environment's build fingerprint the template must hold. */
    fingerprint: string;
}

export type BuildTemplateResult = { ok: true; name: string; reused: boolean } | { ok: false; reason: 'org_not_admitted' | 'no_images' | 'bake_failed' | 'not_default_branch' | 'fingerprint_mismatch' | 'save_failed' };

export async function buildEnvironmentTemplate(req: BuildTemplateRequest, d: BuildTemplateDeps): Promise<BuildTemplateResult> {
    // Customer data at rest in the provider needs legal sign-off: until then the pool's admission list is the gate.
    if (req.pool.admission && !req.pool.admission.allowOrgs.includes(req.organizationId)) return { ok: false, reason: 'org_not_admitted' };
    if (!d.provider.images) return { ok: false, reason: 'no_images' };
    const name = templateNameOf(req.organizationId, req.environmentId, req.fingerprint);
    const key = { organizationId: req.organizationId, environmentId: req.environmentId, poolId: req.poolId, fingerprint: req.fingerprint };
    if ((await d.store.find(req.organizationId, req.environmentId, req.poolId, req.fingerprint))?.state === 'ready') return { ok: true, name, reused: true };
    await d.store.begin({ ...key, name });
    const hostId = `tpl-${name}`;
    const fail = async (reason: Exclude<BuildTemplateResult, { ok: true }>['reason']) => {
        await d.store.fail(key, reason);
        return { ok: false as const, reason };
    };
    try {
        const { providerId } = await d.setupHosts.boot({ hostId, organizationId: req.organizationId, environmentId: req.environmentId, poolId: req.poolId, base: d.cellBase });
        const bake = await d.setupHosts.waitForBake({ hostId, organizationId: req.organizationId, environmentId: req.environmentId });
        if (bake.ok === false) return await fail('bake_failed');
        if (bake.ref !== 'default_branch') return await fail('not_default_branch');
        if (bake.fingerprint !== req.fingerprint) return await fail('fingerprint_mismatch');
        await d.setupHosts.seal(hostId);
        let image = await d.provider.images.save({ providerId, name });
        for (let i = 0; image.state === 'saving' && i < d.poll.attempts; i++) {
            await d.poll.sleep(d.poll.intervalMs ?? 10_000);
            image = (await d.provider.images.get(name)) ?? { name, state: 'failed' };
        }
        if (image.state !== 'ready') return await fail('save_failed');
        for (const older of await d.store.promote(key)) if (older !== name) await d.provider.images.remove(older);
        return { ok: true, name, reused: false };
    } finally {
        await d.setupHosts.destroy(hostId);
    }
}
