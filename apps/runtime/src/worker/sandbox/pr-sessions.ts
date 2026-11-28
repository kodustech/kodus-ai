import type { PullRequestRef, SnapshotPlacements } from '../../shared/persistence/snapshot-placements';

// When a PR closes or merges, nothing of it outlives it: the sessions that
// hold its code (a review's sandbox kept with SandboxSnapshotRequest
// pullRequest) are removed from their cells now (snapshot.forget), not at
// their SessionTTL. Rounds already go with their claims (the pr_closed
// cancel releases them); templates never hold a PR's code.

export interface PrSessionHub {
    post<T>(baseUrl: string, path: string, body: unknown, correlationId?: string, timeoutMs?: number): Promise<T>;
    replicaForCell(cellId: string): Promise<string | null>;
}

export type PrSessionsOutcome = { forgotten: number; kept: number };

export class PullRequestSessions {
    constructor(
        private readonly hub: PrSessionHub,
        private readonly placements: Required<Pick<SnapshotPlacements, 'sessionsOf' | 'forget'>>,
        private readonly log?: (msg: string, meta: Record<string, unknown>) => void,
    ) {}

    /**
     * Removes the PR's sessions from every cell that holds one. A cell that
     * removed them, or that keeps no such thing (an older cell: its sessions go
     * at SessionTTL), drops their rows; a cell that refused or is not
     * connected keeps them for the next close or the API's sweep.
     */
    async forget(orgId: string, pr: PullRequestRef): Promise<PrSessionsOutcome> {
        const sessions = await this.placements.sessionsOf(orgId, pr);
        const byCell = new Map<string, string[]>();
        for (const s of sessions) byCell.set(s.cellId, [...(byCell.get(s.cellId) ?? []), s.snapshotId]);
        let forgotten = 0;
        let kept = 0;
        for (const [cellId, ids] of byCell) {
            for (let i = 0; i < ids.length; i += 64) {
                const chunk = ids.slice(i, i + 64);
                const done = await this.forgetOn(orgId, cellId, chunk);
                if (done) {
                    await this.placements.forget(orgId, chunk);
                    forgotten += chunk.length;
                } else kept += chunk.length;
            }
        }
        if (sessions.length) this.log?.('pr.sessions.forget', { organizationId: orgId, repositoryId: pr.repositoryId, prNumber: pr.prNumber, forgotten, kept });
        return { forgotten, kept };
    }

    private async forgetOn(orgId: string, cellId: string, snapshotIds: string[]): Promise<boolean> {
        // A directory that cannot be read is a cell out of reach: its sessions are kept and counted in `kept`.
        const url = await this.hub.replicaForCell(cellId).catch(() => null);
        if (!url) return false;
        try {
            await this.hub.post(url, `/internal/cells/${encodeURIComponent(cellId)}/forget-sessions`, { organizationId: orgId, snapshotIds }, undefined, 30_000);
            return true;
        } catch {
            return false; // refused or unreachable: kept for the next close or the sweep
        }
    }
}
