import type { Pool } from 'pg';

// Where each memory snapshot of a sandbox lives: a snapshot never leaves the
// cell that took it, so a sandbox that starts from it is reserved there first
// (runtime_snapshot_cells, migration 30). ref: template:<key> or session:<id>.
// A session that holds a PR's code names the PR (migration 31): it is removed
// when the PR closes or merges.

export interface PullRequestRef {
    repositoryId: string;
    prNumber: number;
}

export interface PlacedSession {
    snapshotId: string;
    cellId: string;
}

export interface SnapshotPlacements {
    record(orgId: string, ref: string, cellId: string, pullRequest?: PullRequestRef): Promise<void>;
    cellOf(orgId: string, ref: string): Promise<string | undefined>;
    /** The sessions that hold this PR's code, with their cells. */
    sessionsOf?(orgId: string, pr: PullRequestRef): Promise<PlacedSession[]>;
    /** Drops the rows of these sessions (removed from their cell, or gone with it). */
    forget?(orgId: string, snapshotIds: string[]): Promise<void>;
}

export const templateRef = (key: string) => `template:${key}`;
export const sessionRef = (snapshotId: string) => `session:${snapshotId}`;
export const SESSION = 'session:';

export class PgSnapshotPlacements implements SnapshotPlacements {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async record(orgId: string, ref: string, cellId: string, pullRequest?: PullRequestRef): Promise<void> {
        // The newest template of a key is the one a sandbox starts from, so the last cell to make one wins.
        await this.pool.query(
            `INSERT INTO runtime.runtime_snapshot_cells (org_id, snapshot_ref, cell_id, repository_id, pr_number) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (org_id, snapshot_ref) DO UPDATE SET cell_id = EXCLUDED.cell_id, repository_id = EXCLUDED.repository_id, pr_number = EXCLUDED.pr_number, created_at = now()`,
            [orgId, ref, cellId, pullRequest?.repositoryId ?? null, pullRequest?.prNumber ?? null],
        );
    }

    async cellOf(orgId: string, ref: string): Promise<string | undefined> {
        const r = await this.pool.query<{ cell_id: string }>('SELECT cell_id FROM runtime.runtime_snapshot_cells WHERE org_id = $1 AND snapshot_ref = $2', [orgId, ref]);
        return r.rows[0]?.cell_id;
    }

    async sessionsOf(orgId: string, pr: PullRequestRef): Promise<PlacedSession[]> {
        const r = await this.pool.query<{ snapshot_ref: string; cell_id: string }>(
            `SELECT snapshot_ref, cell_id FROM runtime.runtime_snapshot_cells
             WHERE org_id = $1 AND repository_id = $2 AND pr_number = $3 AND snapshot_ref LIKE 'session:%'`,
            [orgId, pr.repositoryId, pr.prNumber],
        );
        return r.rows.map((row) => ({ snapshotId: row.snapshot_ref.slice(SESSION.length), cellId: row.cell_id }));
    }

    async forget(orgId: string, snapshotIds: string[]): Promise<void> {
        if (!snapshotIds.length) return;
        await this.pool.query('DELETE FROM runtime.runtime_snapshot_cells WHERE org_id = $1 AND snapshot_ref = ANY($2::text[])', [orgId, snapshotIds.map(sessionRef)]);
    }
}

