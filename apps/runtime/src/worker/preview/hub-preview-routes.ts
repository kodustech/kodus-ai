import type { HubClient } from '../env/hub-environment-runtime';
import type { PreviewHubPort } from './preview.service';

/** The hub's preview routes on the replica that holds the claim's cell (internal listener, mTLS like every claim route). */
export class HubPreviewRoutes implements PreviewHubPort {
    constructor(private readonly hub: Pick<HubClient, 'post' | 'replicaForClaim'>) {}

    async route(claim: { claimId: string; organizationId: string }, body: { previewId: string; target: { service: string; port: number }; until: string }): Promise<boolean> {
        const url = await this.hub.replicaForClaim(claim.claimId);
        if (!url) return false;
        const r = await this.hub.post<{ ok?: boolean }>(url, `/internal/claims/${encodeURIComponent(claim.claimId)}/preview-route`, { organizationId: claim.organizationId, ...body }, `preview:${body.previewId}`);
        return r.ok === true;
    }

    async unroute(claim: { claimId: string; organizationId: string }, previewId: string): Promise<void> {
        const url = await this.hub.replicaForClaim(claim.claimId);
        if (!url) return;
        await this.hub.post(url, `/internal/claims/${encodeURIComponent(claim.claimId)}/preview-unroute`, { organizationId: claim.organizationId, previewId }, `preview:${previewId}`);
    }
}
