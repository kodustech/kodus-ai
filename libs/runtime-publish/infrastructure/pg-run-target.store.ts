import type { Pool } from 'pg';

import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { RunTargetConflictError, sameRunTarget, type RunTarget, type RunTargetStore } from '../domain/run-target';

const TABLE = /^("?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?$/;

interface Row {
    run_id: string;
    attempt: number;
    organization_id: string;
    team_id: string;
    repository_id: string;
    repository_name: string;
    repository_full_name: string | null;
    platform: string;
    pr_number: number;
    head_sha: string;
}

/**
 * `runtime_run_targets` over a plain pg Pool, with the semantics of
 * TypeOrmRunTargetStore (idempotent for the same target, a different one is
 * a conflict). For product entry points that run outside the Nest API: the
 * dev e2e scripts stand in for the PR trigger and write the target the same
 * way the product does, so "Run again" finds it. The connection is the
 * product's; the Runtime's own users cannot write this table.
 */
export class PgRunTargetStore implements RunTargetStore {
    private readonly table: string;

    constructor(
        private readonly pool: Pick<Pool, 'query'>,
        opts: { table?: string } = {},
    ) {
        this.table = opts.table ?? '"runtime_run_targets"';
        if (!TABLE.test(this.table)) throw new Error(`invalid table name ${this.table}`);
    }

    async record(target: RunTarget): Promise<void> {
        const inserted = await this.pool.query(
            `INSERT INTO ${this.table} (run_id, attempt, organization_id, team_id, repository_id, repository_name, repository_full_name, platform, pr_number, head_sha)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (run_id) DO NOTHING
             RETURNING run_id`,
            [
                target.runId,
                target.attempt,
                target.organizationId,
                target.teamId,
                target.repositoryId,
                target.repositoryName,
                target.repositoryFullName ?? null,
                target.platform,
                target.pullRequestNumber,
                target.headSha,
            ],
        );
        if (inserted.rowCount) return;
        const existing = await this.get(target.runId);
        if (!existing || !sameRunTarget(existing, target)) throw new RunTargetConflictError(target.runId);
    }

    async get(runId: string): Promise<RunTarget | null> {
        const { rows } = await this.pool.query<Row>(
            `SELECT run_id, attempt, organization_id, team_id, repository_id, repository_name, repository_full_name, platform, pr_number, head_sha
             FROM ${this.table} WHERE run_id = $1`,
            [runId],
        );
        const r = rows[0];
        if (!r) return null;
        return {
            runId: r.run_id,
            attempt: r.attempt,
            organizationId: r.organization_id,
            teamId: r.team_id,
            repositoryId: r.repository_id,
            repositoryName: r.repository_name,
            ...(r.repository_full_name ? { repositoryFullName: r.repository_full_name } : {}),
            platform: r.platform as PlatformType,
            pullRequestNumber: r.pr_number,
            headSha: r.head_sha,
        };
    }
}
