import type { BootstrapPayload, HostProvider } from '@libs/runtime/fleet/host-provider';
import type { HostPool } from '@libs/runtime/fleet/pool';
import { boundKeyOfTemplate } from '@libs/runtime/placement/candidate-pools';

import type { HubFleetPort } from '../per-run-host';
import type { SetupHostPort } from './build-template';

// The live SetupHostPort on boat (docs/runtime/host-providers.md §8.2). The setup host is an ordinary cell
// base host whose fleet token is bound to `template:<org>/<env>`, so the hub places only that environment's
// setup on it (default branch only). Boot, wait and destroy use the provider and the hub's fleet routes; the two
// things runtime-fleet cannot do from here are ports: reading how the environment's setup ended (BakeProbe) and
// sealing the disk (HostSealer: stop the cell, remove identity, token file and /tmp, i.e. `cell-host.sh seal`
// on the host). No exec is used here; whatever implements HostSealer decides how the seal reaches the host.

/** `cellId`: the cell the setup ran on (its record); a bake counts only on the template host's own cell. */
export type BakeState = { state: 'running' } | { state: 'done'; fingerprint: string; ref: 'default_branch' | 'other'; cellId?: string } | { state: 'failed'; reason: string };

/** How the environment's setup on its template host ended, read from the setup records (never from the host). */
export interface BakeProbe {
    read(req: { hostId: string; organizationId: string; environmentId: string }): Promise<BakeState>;
}

/** Makes the host's disk safe to save: no identity, no token file, no /tmp, cell stopped. */
export interface HostSealer {
    seal(req: { hostId: string; providerId: string }): Promise<void>;
}

export interface BoatSetupHostDeps {
    provider: HostProvider;
    /** `connection`: the cell the hub registered for a fleet host (its cell id, connected or not). */
    hub: Pick<HubFleetPort, 'mint' | 'retire'> & { connection(hostId: string): Promise<{ cellId: string | null; connected: boolean }> };
    probe: BakeProbe;
    sealer: HostSealer;
    poolOf(poolId: string): Promise<HostPool | undefined>;
    installation: string;
    bootstrap: Omit<BootstrapPayload, 'token'>;
    poll: { sleep(ms: number): Promise<void>; attempts: number; intervalMs?: number };
    /** How long the setup host's token lives; defaults to 10 minutes. */
    tokenTtlSeconds?: number;
}

export class BoatSetupHost implements SetupHostPort {
    private readonly providerIds = new Map<string, string>();

    constructor(private readonly deps: BoatSetupHostDeps) {}

    async boot(req: { hostId: string; organizationId: string; environmentId: string; poolId: string; fingerprint: string; base: string; from?: string }) {
        const d = this.deps;
        const pool = await d.poolOf(req.poolId);
        if (!pool) throw new Error('pool_gone');
        const minted = await d.hub.mint({ hostId: req.hostId, poolId: req.poolId, boundKey: boundKeyOfTemplate(req.organizationId, req.environmentId), ttlSeconds: d.tokenTtlSeconds ?? 600 });
        if (minted.ok === false) throw new Error('token_refused');
        const create = (from: string, clientToken: string) =>
            d.provider.create({
                hostId: req.hostId,
                clientToken,
                // The build runs in the background and no Run waits on it: wait for a machine rather than fail fast.
                cls: pool.hostClass.provider === 'boat' ? { ...pool.hostClass, boat: { ...pool.hostClass.boat, failFast: false } } : pool.hostClass,
                from,
                bootstrap: { ...d.bootstrap, token: minted.token },
                tags: { installation: d.installation, pool: req.poolId, host: req.hostId },
                saveable: true,
            });
        let source: 'template' | 'base' = 'base';
        let host: Awaited<ReturnType<typeof create>>;
        if (req.from) {
            // The environment's previous template keeps its build cache and image layers. A snapshot that cannot start a host
            // is no reason to lose the build: the cell base builds it cold, as before. The retry has its own client token,
            // since the provider answers a repeated one with the host it already made.
            try {
                host = await create(req.from, req.hostId);
                source = 'template';
            } catch {
                host = await create(req.base, `${req.hostId}-base`);
            }
        } else host = await create(req.base, req.hostId);
        this.providerIds.set(req.hostId, host.providerId);
        return { providerId: host.providerId, source };
    }

    async waitForBake(req: { hostId: string; organizationId: string; environmentId: string }) {
        for (let i = 0; i < this.deps.poll.attempts; i++) {
            const s = await this.deps.probe.read(req);
            if (s.state === 'done') {
                // A setup that ran on another cell baked nothing here: saving this host would keep an empty template.
                const own = (await this.deps.hub.connection(req.hostId)).cellId;
                if (!s.cellId || !own || s.cellId !== own) return { ok: false as const, reason: 'bake_elsewhere' };
                return s.ref === 'default_branch' ? { ok: true as const, fingerprint: s.fingerprint, ref: 'default_branch' as const } : { ok: false as const, reason: 'not_default_branch' };
            }
            if (s.state === 'failed') return { ok: false as const, reason: s.reason };
            await this.deps.poll.sleep(this.deps.poll.intervalMs ?? 10_000);
        }
        return { ok: false as const, reason: 'bake_timeout' };
    }

    async seal(hostId: string) {
        const providerId = await this.providerIdOf(hostId);
        if (!providerId) throw new Error('setup_host_gone');
        await this.deps.sealer.seal({ hostId, providerId });
        // The sealed host's cell identity is revoked at the hub: nothing that was on the disk opens a session again.
        await this.deps.hub.retire(hostId);
    }

    async destroy(hostId: string) {
        const providerId = await this.providerIdOf(hostId);
        // Retire first, each step on its own: one failing never skips the other.
        const errors: unknown[] = [];
        await this.deps.hub.retire(hostId).catch((e) => errors.push(e));
        if (providerId) await this.deps.provider.destroy(providerId).catch((e) => errors.push(e));
        this.providerIds.delete(hostId);
        if (errors.length) throw errors[0];
    }

    private async providerIdOf(hostId: string): Promise<string | undefined> {
        const known = this.providerIds.get(hostId);
        if (known) return known;
        // After a restart the map is empty: the provider's own tag finds the host.
        const found = (await this.deps.provider.list({ installation: this.deps.installation })).find((h) => h.tags.host === hostId);
        return found?.providerId;
    }
}
