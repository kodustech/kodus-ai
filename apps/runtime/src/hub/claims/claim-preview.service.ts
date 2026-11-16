import { newPreviewTunnelTicket, PREVIEW_TUNNEL_TICKET_TTL_SECONDS, previewTicketHash } from '@libs/runtime/contracts/preview';

import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { ClaimRow } from '../hub-store';
import { ClaimScopeError, type ClaimRef, type HubLog } from '../hub-types';

/** Where the hub records a tunnel ticket's hash for the edge to consume (shared/persistence/preview-store.ts). */
export interface PreviewTicketSink {
    insertTunnelTicket(ticketHash: string, cellId: string, expiresAt: string): Promise<void>;
}

export type PreviewRouteOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * The hub's half of preview routing (docs/runtime/preview-urls.md §9.1): it
 * declares to the cell which preview id a preview claim serves, and gives the
 * cell a one-time ticket to dial the edge with. Only a bound claim of
 * consumer preview, on a cell whose hello names the feature, is routed: a
 * Run's machines never serve a preview. The cell checks the target against
 * the claim's expose again.
 */
export class ClaimPreviewService {
    constructor(
        private readonly claims: { scoped(ref: ClaimRef): Promise<ClaimRow | null> },
        private readonly connections: Pick<CellConnectionRegistry, 'request' | 'get'>,
        private readonly tickets: PreviewTicketSink | undefined,
        private readonly tunnelUrl: string | undefined,
        private readonly log: HubLog,
        private readonly now: () => Date,
    ) {}

    async route(ref: ClaimRef, body: { previewId: string; target: { service: string; port: number }; until: string }): Promise<PreviewRouteOutcome> {
        const claim = await this.claims.scoped(ref);
        if (!claim) throw new ClaimScopeError('no such claim');
        if (claim.consumer !== 'preview') return { ok: false, code: 'not_preview_claim', message: 'only a preview claim serves a preview' };
        if (claim.state !== 'bound') return { ok: false, code: 'claim_not_bound', message: `the claim is ${claim.state}` };
        if (!this.tunnelUrl || !this.tickets) return { ok: false, code: 'preview_off', message: 'this hub has no preview edge (RUNTIME_PREVIEW_TUNNEL_URL)' };
        const conn = this.connections.get(claim.cellId);
        if (!conn?.features.includes('preview')) return { ok: false, code: 'preview_unsupported', message: 'this cell serves no previews' };
        const ids = { cellId: claim.cellId, claimId: claim.claimId, previewId: body.previewId };
        const ticket = newPreviewTunnelTicket();
        const expiresAt = new Date(this.now().getTime() + PREVIEW_TUNNEL_TICKET_TTL_SECONDS * 1000).toISOString();
        await this.tickets.insertTunnelTicket(previewTicketHash(ticket), claim.cellId, expiresAt);
        // A cell already connected to this edge ignores the ticket (it expires unused).
        const tunnel = await this.connections.request(claim.cellId, 'preview.tunnel', { url: this.tunnelUrl, ticket, expiresAt });
        if (tunnel.type !== 'ack') {
            this.log('warn', 'preview.tunnel.refused', { ...ids, reply: tunnel.type });
            return { ok: false, code: 'tunnel_refused', message: 'the cell refused to dial the preview edge' };
        }
        const reply = await this.connections.request(claim.cellId, 'preview.route', body, claim.claimId);
        if (reply.type !== 'ack') {
            const code = reply.type === 'nack' ? String((reply.body as { code?: string }).code ?? 'nack') : reply.type;
            this.log('warn', 'preview.route.refused', { ...ids, code });
            return { ok: false, code, message: 'the cell refused the route' };
        }
        this.log('info', 'preview.route', { ...ids, until: body.until });
        return { ok: true };
    }

    async unroute(ref: ClaimRef, previewId: string): Promise<void> {
        const claim = await this.claims.scoped(ref);
        if (!claim) throw new ClaimScopeError('no such claim');
        if (claim.consumer !== 'preview' || !this.connections.get(claim.cellId)) return;
        // A cell that went away has no routes left to close.
        const reply = await this.connections.request(claim.cellId, 'preview.unroute', { previewId }, claim.claimId).catch(() => undefined);
        this.log('info', 'preview.unroute', { cellId: claim.cellId, claimId: claim.claimId, previewId, reply: reply?.type ?? 'unanswered' });
    }
}
