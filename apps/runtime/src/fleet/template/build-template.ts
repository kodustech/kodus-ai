import { randomBytes } from 'crypto';

import { ProviderError } from '@libs/runtime/fleet/provider-error';
import type { HostProvider } from '@libs/runtime/fleet/host-provider';
import type { HostPool } from '@libs/runtime/fleet/pool';

import { templateNameOf } from './template-name';
import type { TemplateStore } from './template-store';

// The environment template on boat (docs/runtime/host-providers.md §8.2): a
// setup host started from the cell base boots the environment on its default
// branch only (S-52: never PR code), bakes the images and seeds the data;
// then it is sealed (cell stopped, identity, token file and /tmp removed),
// saved as kodus-env-<org-hash>-<env-hash>-<fingerprint>, recorded, and the
// environment's older template is replaced. When the environment already has a
// ready template on this cell base, the setup host starts from that template
// instead of the base, so the build cache and the image layers are already on
// its disk; the older snapshot is deleted last, after the setup host that was
// created from it is destroyed. The setup host is destroyed whatever happens. The live SetupHostPort (enrolling
// the setup host, driving its setup, sealing it) waits for the boat spike.

/** What a template build's host was created from: the environment's previous template, or the cell base. */
export type TemplateSource = 'template' | 'base';

/** The setup host's life, as runtime-fleet drives it through the hub. Not built live yet. */
export interface SetupHostPort {
    /** Starts a setup host from the cell base, enrolled with a token bound to the template. */
    boot(req: { hostId: string; organizationId: string; environmentId: string; poolId: string; fingerprint: string; base: string; from?: string }): Promise<{ providerId: string; source: TemplateSource }>;
    /** Waits for the environment's setup on that host; what it baked, and on which ref. */
    waitForBake(req: { hostId: string; organizationId: string; environmentId: string }): Promise<{ ok: true; fingerprint: string; ref: 'default_branch'; sha?: string } | { ok: false; reason: string }>;
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
    /** Said, not silent: a previous snapshot that could not be deleted. */
    log?(msg: string, fields: Record<string, unknown>): void;
    poll: { sleep(ms: number): Promise<void>; attempts: number; intervalMs?: number };
}

export interface BuildTemplateRequest {
    organizationId: string;
    environmentId: string;
    poolId: string;
    pool: HostPool;
    /** The template's row fingerprint: the key of the build inputs, or, for a freshness rebuild of an unchanged key, a value of its own. */
    fingerprint: string;
    /** The key the template's bake must report (host-providers.md §8.2.2); the fingerprint when absent. */
    inputKey?: string;
}

/** `source`: what the setup host was created from; absent when no host was made (reused, refused, or the boot itself threw). */
export type BuildTemplateResult =
    | { ok: true; name: string; reused: boolean; source?: TemplateSource }
    | { ok: false; reason: 'org_not_admitted' | 'no_images' | 'already_building' | 'bake_failed' | 'not_default_branch' | 'fingerprint_mismatch' | 'save_failed' | 'build_error'; cause?: string; source?: TemplateSource };

/** Why a step threw, safe to log and store: a provider's code, or one of this module's own error words; never a free message. */
function causeOf(e: unknown): string {
    if (e instanceof ProviderError) return e.code;
    const m = e instanceof Error ? e.message : '';
    return /^[a-z][a-z0-9_]{2,40}$/.test(m) ? m : 'unexpected';
}

/** Ends the stored failure of a build that started from the previous template: the next attempt starts from the cell base. */
export const TEMPLATE_SOURCED_FAILURE = '@template';

export async function buildEnvironmentTemplate(req: BuildTemplateRequest, d: BuildTemplateDeps): Promise<BuildTemplateResult> {
    // Customer data at rest in the provider needs legal sign-off: until then the pool's admission list is the gate.
    if (req.pool.admission && !req.pool.admission.allowOrgs.includes(req.organizationId)) return { ok: false, reason: 'org_not_admitted' };
    const images = d.provider.images;
    if (!images) return { ok: false, reason: 'no_images' };
    const name = templateNameOf(req.organizationId, req.environmentId, req.fingerprint, d.cellBase);
    const key = { organizationId: req.organizationId, environmentId: req.environmentId, poolId: req.poolId, fingerprint: req.fingerprint };
    // Ready on another cell base is not this template: its disk holds the old cell (template-store.ts).
    const found = await d.store.find(req.organizationId, req.environmentId, req.poolId, req.fingerprint);
    if (found?.state === 'ready' && found.cellBase === d.cellBase) return { ok: true, name: found.name, reused: true };
    // The environment's previous ready template on this base holds the build cache and the image layers of its last
    // setup: starting from it makes the new setup incremental. Another base's template holds another cell and is never
    // a source; a snapshot the provider no longer has is not either.
    const previous = await d.store.readyName(req.organizationId, req.environmentId, req.poolId, d.cellBase);
    // A build that started from the template and failed leaves a marker: the next attempt goes cold from the base, so a
    // template that cannot build never blocks rebuilds.
    const lastFailure = await d.store.lastFailure(req.organizationId, req.environmentId, req.poolId, d.cellBase);
    const from = previous && previous !== name && !lastFailure?.endsWith(TEMPLATE_SOURCED_FAILURE) && (await images.get(previous))?.state === 'ready' ? previous : undefined;
    // One host per attempt: the hub enrolls a host id once, so a retry of the same template needs its own.
    const hostId = `tpl-${randomBytes(12).toString('hex')}`;
    // The row names the setup host before it exists: the orphan pass spares it while the template builds.
    if (!(await d.store.begin({ ...key, name, cellBase: d.cellBase, setupHostId: hostId, inputKey: req.inputKey ?? req.fingerprint }))) return { ok: false, reason: 'already_building' };
    let source: TemplateSource | undefined;
    const fail = async (reason: Exclude<BuildTemplateResult, { ok: true }>['reason'], cause?: string) => {
        await d.store.fail(key, `${cause ? `${reason}:${cause}` : reason}${source === 'template' ? TEMPLATE_SOURCED_FAILURE : ''}`);
        return { ok: false as const, reason, ...(cause ? { cause } : {}), ...(source ? { source } : {}) };
    };
    // The snapshots this build replaced. They are deleted after the setup host is gone: the host was created from one of them.
    let retired: string[] = [];
    let result: BuildTemplateResult;
    try {
        const booted = await d.setupHosts.boot({ hostId, organizationId: req.organizationId, environmentId: req.environmentId, poolId: req.poolId, fingerprint: req.fingerprint, base: d.cellBase, ...(from ? { from } : {}) });
        const { providerId } = booted;
        source = booted.source;
        result = await build(providerId);
    } catch (e) {
        // A throw from any step (the seal, the save, the provider) records the row failed, never left building, with why.
        result = await fail('build_error', causeOf(e));
    } finally {
        await d.setupHosts.destroy(hostId);
    }
    for (const older of retired)
        await images.remove(older).catch((e) => d.log?.('template.retire_failed', { environmentId: req.environmentId, poolId: req.poolId, cause: causeOf(e) }));
    return result;

    async function build(providerId: string): Promise<BuildTemplateResult> {
        const bake = await d.setupHosts.waitForBake({ hostId, organizationId: req.organizationId, environmentId: req.environmentId });
        if (bake.ok === false) return await fail('bake_failed');
        if (bake.ref !== 'default_branch') return await fail('not_default_branch');
        if (bake.fingerprint !== (req.inputKey ?? req.fingerprint)) return await fail('fingerprint_mismatch');
        await d.setupHosts.seal(hostId);
        let image = await images.save({ providerId, name });
        for (let i = 0; image.state === 'saving' && i < d.poll.attempts; i++) {
            await d.poll.sleep(d.poll.intervalMs ?? 10_000);
            image = (await images.get(name)) ?? { name, state: 'failed' };
        }
        if (image.state !== 'ready') return await fail('save_failed');
        retired = (await d.store.promote(key, bake.sha)).filter((older) => older !== name);
        return { ok: true, name, reused: false, ...(source ? { source } : {}) };
    }
}
