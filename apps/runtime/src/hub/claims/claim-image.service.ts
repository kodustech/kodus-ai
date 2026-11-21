import { type BakeOutcome, type BakeRequest, POOL_SIZE_UNSUPPORTED } from '@libs/runtime/environment';
import type { Envelope, MachineSize, MessageBody } from '@libs/runtime/protocol';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import { supports } from '../cell-capabilities';
import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { HubStore } from '../hub-store';
import { CellUnavailableError, ClaimScopeError } from '../hub-types';

/**
 * What becomes an image or a pool machine: a bake only of the default-branch
 * commit a setup claim booted, and pool machines only from a baked image.
 * Never from a claim that ran PR code.
 */
export class ClaimImageService {
    constructor(
        private readonly store: HubStore,
        private readonly connections: CellConnectionRegistry,
        private readonly metrics: RuntimeMetrics,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /**
     * image.bake: only for the default-branch commit the setup claim
     * booted. A bake tied to a PR claim or to a Run's claim is refused here,
     * before it reaches the cell (which refuses it again).
     */
    async bake(req: BakeRequest & { claimId: string }): Promise<BakeOutcome> {
        const claim = await this.store.claim(req.claimId);
        if (!claim || claim.orgId !== req.organizationId || (claim.environmentId && claim.environmentId !== req.environmentId)) {
            return { status: 'refused', code: 'unknown_claim', message: 'the claim is not this environment' };
        }
        if (claim.side === 'pr') {
            this.metrics.recordProtocolViolation({ cellId: claim.cellId, code: 'bake_from_pr' });
            return { status: 'refused', code: 'pr_claim', message: 'a claim that ran PR code never becomes an image (S-52)' };
        }
        if (claim.runId || claim.side !== 'setup') return { status: 'refused', code: 'not_setup_claim', message: 'only a setup claim can ask for a bake' };
        if (claim.state !== 'bound') return { status: 'refused', code: 'claim_not_bound', message: `the claim is ${claim.state}` };
        // A multi-repository bake is keyed by every repository's commit: a cell that cannot read the key
        // would key it by this commit alone, and a Run on another member's commit would boot it.
        const session = (await this.store.session(claim.cellId)) ?? {};
        if (req.refsDigest && !supports(session, 'workspace')) {
            return { status: 'refused', code: 'workspace_unsupported', message: "this cell's build cannot key a bake by every repository's commit (its hello names no workspace)" };
        }
        // Asked before it is sent: the cell's image.shared for it is recorded only against this ask.
        if (supports(session, 'bakeShare')) {
            await this.store.recordBakeAsk({ cellId: claim.cellId, orgId: req.organizationId, environmentId: req.environmentId, envKey: req.refsDigest ?? req.sha, recipeSha: req.recipeSha, askedAt: this.now().toISOString() });
        }
        let reply: Envelope;
        try {
            reply = await this.connections.request(
                claim.cellId,
                'image.bake',
                { orgId: req.organizationId, environmentId: req.environmentId, recipeSha: req.recipeSha, sha: req.sha, ...(req.refsDigest ? { refsDigest: req.refsDigest } : {}) },
                claim.claimId,
            );
        } catch (e) {
            if (e instanceof CellUnavailableError) return { status: 'refused', code: 'cell_unavailable', message: e.message };
            throw e;
        }
        if (reply.type === 'nack') {
            const b = reply.body as MessageBody<'nack'>;
            return { status: 'refused', code: b.code, message: b.message };
        }
        return { status: 'accepted' };
    }

    /**
     * image.shared (feature bakeShare): what a cell pushed to the org's registry for one of its bakes. Recorded only
     * for a bake this hub asked of this cell for this org (runtime_bake_asks), and a customer's cell speaks only for
     * its own org. The answer is the code of the refusal, or undefined when recorded.
     */
    async recordShared(conn: { cellId: string; owner: 'kodus' | 'customer'; orgId?: string | null; features: readonly string[] }, body: MessageBody<'image.shared'>): Promise<{ code: string; message: string } | undefined> {
        if (!conn.features.includes('bakeShare')) return { code: 'feature_not_named', message: 'image.shared is sent only by a cell whose hello names bakeShare' };
        if (conn.owner === 'customer' && body.orgId !== conn.orgId) {
            this.metrics.recordProtocolViolation({ cellId: conn.cellId, code: 'shared_wrong_org' });
            return { code: 'wrong_org', message: "a customer's cell shares only its own org's bakes" };
        }
        const outcome = await this.store.recordSharedImages({
            cellId: conn.cellId,
            orgId: body.orgId,
            environmentId: body.environmentId,
            envKey: body.refsDigest ?? body.sha,
            recipeSha: body.recipeSha,
            images: body.images,
            pushedAt: this.now().toISOString(),
        });
        if (outcome === 'not_asked') return { code: 'bake_not_asked', message: 'this hub asked this cell for no such bake of the org' };
        return undefined;
    }

    /** The environment is removed: its shared images' records go. */
    forgetSharedImages(organizationId: string, environmentId: string): Promise<number> {
        return this.store.removeSharedImages(organizationId, environmentId);
    }

    /**
     * snapshot.forget: the org's sessions on this cell go now (their PR closed or merged).
     * `unsupported`: the cell does not name snapshotForget (an older one); its sessions go at
     * its SessionTTL instead, so the caller drops them from its list.
     */
    async forgetSessions(cellId: string, req: { organizationId: string; snapshotIds: string[] }): Promise<{ status: 'forgotten' | 'unsupported' } | { status: 'refused'; code: string; message: string }> {
        const session = await this.store.session(cellId);
        if (session?.owner === 'customer' && session.orgId !== req.organizationId) throw new ClaimScopeError('cell does not serve this organization');
        if (!supports(session ?? {}, 'snapshotForget')) return { status: 'unsupported' };
        const reply = await this.connections.request(cellId, 'snapshot.forget', { orgId: req.organizationId, snapshotIds: req.snapshotIds });
        if (reply.type === 'nack') {
            const b = reply.body as MessageBody<'nack'>;
            return { status: 'refused', code: b.code, message: b.message };
        }
        return { status: 'forgotten' };
    }

    /** pool.target: pool machines come from a baked image, never from a claim. */
    async poolTarget(cellId: string, req: { organizationId: string; environmentId: string; imageId: string; size: number; machineSize?: MachineSize; claimId?: string }): Promise<BakeOutcome> {
        if (req.claimId) {
            const claim = await this.store.claim(req.claimId);
            if (claim?.side === 'pr') return { status: 'refused', code: 'pr_claim', message: 'a claim that ran PR code never becomes a pool machine (S-52)' };
            return { status: 'refused', code: 'pool_from_claim', message: 'pool machines come from a baked image, never from a claim' };
        }
        const session = await this.store.session(cellId);
        if (session?.owner === 'customer' && session.orgId !== req.organizationId) throw new ClaimScopeError('cell does not serve this organization');
        // A cell that does not decode machineSize would make the pool at its default size, which a
        // sized Run's claim never adopts: it is asked for no machines instead (draining any it kept).
        const sizedOnOldCell = !!req.machineSize && !supports(session ?? {}, 'poolMachineSize');
        const body = { orgId: req.organizationId, environmentId: req.environmentId, imageId: req.imageId, size: sizedOnOldCell ? 0 : req.size };
        const reply = await this.connections.request(cellId, 'pool.target', req.machineSize && !sizedOnOldCell ? { ...body, machineSize: req.machineSize } : body);
        if (reply.type === 'nack') {
            const b = reply.body as MessageBody<'nack'>;
            return { status: 'refused', code: b.code, message: b.message };
        }
        if (sizedOnOldCell) return { status: 'refused', code: POOL_SIZE_UNSUPPORTED, message: 'this cell makes pool machines only at its default size; update it to keep a pool for this machine size' };
        return { status: 'accepted' };
    }
}
