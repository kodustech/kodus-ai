import { ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { SANDBOX_ENVIRONMENT_ID } from '@libs/runtime/protocol/sandbox';

import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { ApprovedEgress, HubStore } from '../hub-store';
import type { HubLog, HubLogLine } from '../hub-types';

type LogIds = Omit<HubLogLine, 'level' | 'msg' | 'replicaId'>;

/**
 * Whether the environment's approved egress hosts reach a claim: a setup or
 * base claim, and a PR claim whose code is the repository's own. The PR side
 * of a pull request from a fork runs code nobody in the org wrote, so it
 * keeps the base list and never gets the hosts an admin approved.
 */
export const receivesApprovedHosts = (claim: { side: string; forkPullRequest?: boolean | null }): boolean => !(claim.side === 'pr' && claim.forkPullRequest === true);

/** egress.policy (and claim.acquire's egress fields) for one cell: inspect and the recommended switch only to a cell that names egressTiers. */
export const egressBodyFor = (features: readonly string[], egress: ApprovedEgress) => ({
    allow: egress.allow,
    ...(features.includes('egressTiers') && egress.inspect.length ? { inspect: egress.inspect } : {}),
});

/** The environment's approved egress hosts, to the claims that may have them: in the acquire, after claim.ready, and on a new approval. */
export class ClaimEgressService {
    constructor(
        private readonly store: HubStore,
        private readonly connections: CellConnectionRegistry,
        private readonly log: HubLog,
        private readonly now: () => Date,
    ) {}

    /** The environment's approved egress (and the org list), lowercased and sorted; empty when it cannot be read (logged). */
    async approvedEgressOf(orgId: string, environmentId: string, ids: LogIds): Promise<ApprovedEgress> {
        try {
            const e = await this.store.approvedEgress(orgId, environmentId);
            const allow = [...new Set(e.allow.map((h) => h.toLowerCase()))].sort().slice(0, 256);
            return { allow, inspect: e.inspect.filter((r) => allow.includes(r.host)).slice(0, 256) };
        } catch (e) {
            this.log('error', 'claim.egress_policy.unread', { ...ids, error: (e as Error).message });
            return { allow: [], inspect: [] };
        }
    }

    /** The environment's approved hosts, lowercased and sorted; empty when they cannot be read (logged). */
    async approvedHostsOf(orgId: string, environmentId: string, ids: LogIds): Promise<string[]> {
        return (await this.approvedEgressOf(orgId, environmentId, ids)).allow;
    }

    /** Whether the org keeps the Kodus recommended list on (D2); on when it cannot be read (the cell's own list is the floor). */
    async recommendedEnabledOf(orgId: string, ids: LogIds): Promise<boolean> {
        try {
            return await this.store.egressRecommendedEnabled(orgId);
        } catch (e) {
            this.log('warn', 'claim.egress_settings.unread', { ...ids, error: (e as Error).message });
            return true;
        }
    }

    /** D5: the claim got these approvals now; the screen shows each one's last use. Never fails the claim. */
    async markSent(orgId: string, environmentId: string, hosts: string[]): Promise<void> {
        await this.store.markEgressSent(orgId, environmentId, hosts, this.now()).catch((e) => this.log('warn', 'claim.egress_sent.unrecorded', { error: (e as Error).message }));
    }

    /**
     * A sandbox claim's egress: the hosts approved for sandboxes (its own
     * environment, SANDBOX_ENVIRONMENT_ID) and the ones its caller names (the
     * git host it fetches from), lowercased, sorted, at most 256. Never an
     * environment's approvals nor the org list: those are for setups and Runs
     * (G5, docs/runtime/egress-allowlist.md §8). The cell's platform deny list
     * still refuses any of them it names.
     */
    async sandboxEgressOf(orgId: string, asked: string[], ids: LogIds): Promise<ApprovedEgress> {
        const own = await this.approvedEgressOf(orgId, SANDBOX_ENVIRONMENT_ID, ids);
        const allow = [...new Set([...asked, ...own.allow].map((h) => h.toLowerCase()))].sort().slice(0, 256);
        return { allow, inspect: own.inspect.filter((r) => allow.includes(r.host)) };
    }

    /** The sandbox's hosts (sandboxEgressOf's allow). */
    async sandboxHostsOf(orgId: string, asked: string[], ids: LogIds): Promise<string[]> {
        return (await this.sandboxEgressOf(orgId, asked, ids)).allow;
    }

    /**
     * Seals a sandbox claim's egress for good: egress.policy with `sealed` and nothing allowed.
     * True only when the cell acked, which it does once the enforcers hold the sealed policy;
     * a nack (an older cell refuses the field), a lost connection or a timeout is false, and the
     * caller must treat the sandbox as open.
     */
    async sealSandbox(cellId: string, claimId: string, ids: LogIds): Promise<boolean> {
        try {
            const reply = await this.connections.request(cellId, 'egress.policy', { allow: [], sealed: true, issuedAt: this.now().toISOString() }, claimId);
            this.log(reply.type === 'ack' ? 'info' : 'warn', 'claim.egress_sealed', { ...ids, reply: reply.type, ...(reply.type === 'nack' ? { code: (reply.body as { code?: string }).code } : {}) });
            return reply.type === 'ack';
        } catch (e) {
            this.log('warn', 'claim.egress_sealed', { ...ids, error: (e as Error).message });
            return false;
        }
    }

    /** egress.policy with the environment's approved hosts, to one claim right after claim.ready. */
    async pushApprovedHosts(cellId: string, claimId: string, orgId: string, environmentId: string, ids: LogIds): Promise<void> {
        const egress = await this.approvedEgressOf(orgId, environmentId, ids);
        if (!egress.allow.length) return;
        try {
            const features = this.connections.get(cellId)?.features ?? [];
            const reply = await this.connections.request(cellId, 'egress.policy', { ...egressBodyFor(features, egress), issuedAt: this.now().toISOString() }, claimId);
            this.log(reply.type === 'ack' ? 'info' : 'warn', 'claim.egress_policy', { ...ids, hosts: egress.allow.length, inspected: egress.inspect.length, reply: reply.type });
            if (reply.type === 'ack') await this.markSent(orgId, environmentId, egress.allow);
        } catch (e) {
            // The claim keeps the base list; an approval after this still reaches it (pushEgressPolicy).
            this.log('warn', 'claim.egress_policy', { ...ids, hosts: egress.allow.length, error: (e as Error).message });
        }
    }

    /**
     * An approval or a revocation reaches the environment's live claims that
     * may have it (receivesApprovedHosts): each claim's full list, read again
     * from the approvals (with its inspected hosts), goes to the cell that
     * holds it and replaces the previous one; a revoked host leaves it, which
     * cuts the claim's connections to it. ORG_EGRESS_SCOPE reaches every
     * environment of the org, never a sandbox. `allow` is what a worker
     * computed; it is used only when the approvals cannot be read. Only the
     * cells this replica holds are reached; returns the claims sent to.
     */
    async pushEgressPolicy(orgId: string, environmentId: string, allow: string[]): Promise<string[]> {
        const sent: string[] = [];
        const fallback: ApprovedEgress = { allow: [...new Set(allow.map((h) => h.toLowerCase()))].sort(), inspect: [] };
        const claims = environmentId === ORG_EGRESS_SCOPE
            ? (await this.store.liveClaimsOfOrganization(orgId)).filter((c) => c.environmentId !== SANDBOX_ENVIRONMENT_ID)
            : await this.store.liveClaimsOfEnvironment(orgId, environmentId);
        const byEnvironment = new Map<string, ApprovedEgress>();
        for (const claim of claims) {
            const conn = this.connections.get(claim.cellId);
            if (!conn) continue;
            if (!receivesApprovedHosts(claim)) {
                this.log('info', 'claim.egress_policy.fork_skipped', { cellId: claim.cellId, claimId: claim.claimId, runId: claim.runId ?? undefined });
                continue;
            }
            const ids = { cellId: claim.cellId, claimId: claim.claimId, runId: claim.runId ?? undefined };
            let egress = byEnvironment.get(claim.environmentId);
            if (!egress) {
                egress = await this.store.approvedEgress(orgId, claim.environmentId).catch((e: unknown) => {
                    this.log('error', 'claim.egress_policy.unread', { ...ids, error: (e as Error).message, fallback: 'worker_list' });
                    return fallback;
                });
                byEnvironment.set(claim.environmentId, egress);
            }
            try {
                const reply = await this.connections.request(claim.cellId, 'egress.policy', { ...egressBodyFor(conn.features, egress), issuedAt: this.now().toISOString() }, claim.claimId);
                if (reply.type === 'ack') sent.push(claim.claimId);
                this.log('info', 'claim.egress_policy', { ...ids, hosts: egress.allow.length, inspected: egress.inspect.length, reply: reply.type });
            } catch (e) {
                // The cell's next claim gets the list in its acquire path; a dead cell has no live claim.
                this.log('warn', 'claim.egress_policy', { ...ids, error: (e as Error).message });
            }
        }
        return sent;
    }
}
