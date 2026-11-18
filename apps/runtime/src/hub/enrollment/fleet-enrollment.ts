import { type FleetTokenLedger, generateFleetToken } from '@libs/runtime/contracts/fleet-token';

import type { CellRegistryRepository } from '../hub-store';
import type { HubLog } from '../hub-types';

// What runtime-fleet may ask of cell identity (docs/runtime/host-providers.md
// §8.1), and nothing else: a single-use token for one host of a pool a
// controller drives, and the retirement of that host's cell before the host
// is destroyed. The routes take only the fleet's CN (FleetAuthGuard).

export type MintResult =
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; reason: 'unknown_pool' | 'static_pool' | 'already_registered' };

export class FleetEnrollment {
    constructor(
        private readonly registry: Pick<CellRegistryRepository, 'hostPool' | 'retireHostCell'>,
        private readonly ledger: FleetTokenLedger,
        private readonly log: HubLog,
    ) {}

    async mint(req: { hostId: string; poolId: string; boundKey: string | null; ttlSeconds: number; issuedBy: string }): Promise<MintResult> {
        const pool = await this.registry.hostPool(req.poolId);
        if (!pool) return { ok: false, reason: 'unknown_pool' };
        // A static pool's hosts are registered by a person with an org's kcr_ token; nothing mints for them.
        if (pool.provider === 'static') return { ok: false, reason: 'static_pool' };
        const { token, tokenHash } = generateFleetToken();
        const issued = await this.ledger.issue({ tokenHash, poolId: req.poolId, hostId: req.hostId, boundKey: req.boundKey, ttlMs: req.ttlSeconds * 1000, issuedBy: req.issuedBy });
        if (issued === 'already_registered') return { ok: false, reason: 'already_registered' };
        this.log('info', 'fleet.token_minted', { hostId: req.hostId, poolId: req.poolId });
        return { ok: true, token, expiresAt: new Date(Date.now() + Math.min(req.ttlSeconds, 3600) * 1000).toISOString() };
    }

    async retire(hostId: string, by: string): Promise<string | null> {
        const cellId = await this.registry.retireHostCell(hostId, by);
        this.log('info', 'fleet.host_cell_retired', { hostId, cellId });
        return cellId;
    }
}
