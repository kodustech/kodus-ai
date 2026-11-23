import { type FleetTokenLedger, generateFleetToken } from '@libs/runtime/contracts/fleet-token';

import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { CellRegistryRepository } from '../hub-store';
import type { HubLog } from '../hub-types';

// What runtime-fleet may ask of cell identity (docs/runtime/host-providers.md
// §8.1), and nothing else: a single-use token for one host of a pool a
// controller drives, and the retirement of that host's cell before the host
// is destroyed. The routes take only the fleet's CN (FleetAuthGuard).

const TEMPLATE_KEY = /^template:[^/\s]{1,128}\/[^/\s]{1,128}$/;

export type MintResult =
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; reason: 'unknown_pool' | 'static_pool' | 'already_registered' };

export type SealResult =
    | { ok: true; cellId: string }
    // not_template: the cell is not a template's setup host (its bound key is not template:<org>/<env>); the hub never asks it.
    | { ok: false; reason: 'no_cell' | 'not_template' | 'not_connected' | 'refused'; code?: string };

export class FleetEnrollment {
    constructor(
        private readonly registry: Pick<CellRegistryRepository, 'hostPool' | 'retireHostCell' | 'fleetHostCell'>,
        private readonly ledger: FleetTokenLedger,
        private readonly log: HubLog,
        private readonly connections?: Pick<CellConnectionRegistry, 'request' | 'get'>,
    ) {}

    /**
     * Asks the connected cell of a template's setup host to seal itself (cell.seal; docs/runtime/host-providers.md §8.2)
     * and returns when the cell answered. Only a cell bound to `template:<org>/<env>`: a perRun host or a pooled cell is
     * never asked. The cell's connection is this replica's.
     */
    async seal(hostId: string, by: string): Promise<SealResult> {
        const cell = await this.registry.fleetHostCell(hostId);
        if (!cell) return { ok: false, reason: 'no_cell' };
        if (!cell.boundKey || !TEMPLATE_KEY.test(cell.boundKey)) return { ok: false, reason: 'not_template' };
        if (!this.connections?.get(cell.cellId)) return { ok: false, reason: 'not_connected' };
        const reply = await this.connections.request(cell.cellId, 'cell.seal', {}).catch(() => undefined);
        if (reply?.type !== 'ack') {
            const code = reply?.type === 'nack' ? String((reply.body as { code?: string }).code ?? 'nack') : 'unanswered';
            this.log('warn', 'fleet.host_seal_refused', { hostId, cellId: cell.cellId, code, by });
            return { ok: false, reason: 'refused', code };
        }
        this.log('info', 'fleet.host_sealing', { hostId, cellId: cell.cellId, by });
        return { ok: true, cellId: cell.cellId };
    }

    /** Whether the host's cell is connected now: the fleet waits for it to go after a seal. */
    async hostConnection(hostId: string): Promise<{ cellId: string | null; connected: boolean }> {
        const cell = await this.registry.fleetHostCell(hostId);
        return { cellId: cell?.cellId ?? null, connected: cell?.connected ?? false };
    }

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
