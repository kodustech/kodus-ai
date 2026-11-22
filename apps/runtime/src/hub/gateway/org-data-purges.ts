import type { Envelope, MessageBody } from '@libs/runtime/protocol';

import type { HubLog } from '../hub-types';
import type { CellConnection, CellConnectionRegistry } from './cell-connections';

// The org purge's cell leg (docs/runtime/persistent-state.md D13): one
// org.purge to every connected cell that may hold data of the org, answered
// per cell with org.purged. The worker's purge waits for every cell to say so
// (OrganizationPurgeRequestedHandler) and asks again until they have, so this
// keeps only what makes an ask cheap to repeat: which (org, cell) pairs have
// already acknowledged, in memory. A hub that restarts forgets them and sends
// again, which the cell answers the same way (a purge of nothing).

export type CellPurgeState = 'purged' | 'pending';

export interface OrgDataPurgeStatus {
    /** The cells this replica holds that may hold data of the org (named toolLayers, may serve the org). */
    cells: number;
    purged: number;
    /** Not acknowledged yet: asked now and not answered, refused while a claim of the org is live on the cell, or unreachable. */
    pending: number;
}

/** What is held for an org: its acknowledgements, at most one per cell this replica ever held. */
const MAX_ORGS_REMEMBERED = 5_000;

export class OrgDataPurges {
    private readonly byOrg = new Map<string, Map<string, CellPurgeState>>();

    constructor(
        private readonly connections: CellConnectionRegistry,
        private readonly log: HubLog,
    ) {}

    /** The cells of this replica that keep data at rest for an org: the ones whose hello names toolLayers and that may serve it. */
    private holders(orgId: string): CellConnection[] {
        return this.connections
            .heldCellIds()
            .map((id) => this.connections.get(id))
            .filter((c): c is CellConnection => !!c && c.features.includes('toolLayers') && (c.cred.owner === 'kodus' || c.cred.orgId === orgId));
    }

    /**
     * Asks every holder that has not acknowledged yet. Idempotent: an acknowledged cell is not asked again, a
     * pending one is (the cell answers a repeat the same way). A cell that refuses (a claim of the org is live on
     * it) or does not answer stays pending; nothing here ever throws for a cell.
     */
    async request(orgId: string): Promise<OrgDataPurgeStatus> {
        const holders = this.holders(orgId);
        let states = this.byOrg.get(orgId);
        if (!states) {
            if (this.byOrg.size >= MAX_ORGS_REMEMBERED) this.byOrg.delete(this.byOrg.keys().next().value!);
            states = new Map();
            this.byOrg.set(orgId, states);
        }
        const ask = holders.filter((c) => states!.get(c.cred.cellId) !== 'purged');
        await Promise.all(
            ask.map(async (c) => {
                const cellId = c.cred.cellId;
                states!.set(cellId, 'pending');
                try {
                    const reply = await this.connections.request(cellId, 'org.purge', { orgId });
                    if (reply.type !== 'ack') this.log('info', 'org.purge.refused', { cellId, orgId, code: (reply.body as { code?: string }).code });
                } catch (e) {
                    this.log('warn', 'org.purge.unanswered', { cellId, orgId, error: (e as Error).message });
                }
            }),
        );
        let purged = 0;
        for (const c of holders) if (states.get(c.cred.cellId) === 'purged') purged++;
        return { cells: holders.length, purged, pending: holders.length - purged };
    }

    /** org.purged from a cell: the pair is acknowledged, only for a cell that was asked about this org. */
    onPurged(conn: Pick<CellConnection, 'cred'>, msg: Envelope<'org.purged'>): 'recorded' | 'unasked' {
        const body = msg.body as MessageBody<'org.purged'>;
        const states = this.byOrg.get(body.orgId);
        if (!states?.has(conn.cred.cellId)) return 'unasked';
        states.set(conn.cred.cellId, 'purged');
        this.log('info', 'org.purged', { cellId: conn.cred.cellId, orgId: body.orgId, kinds: body.purged.join(',') });
        return 'recorded';
    }
}
