import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// What the product worker published on the PR for a Run (ADR-052), in the
// product Postgres. The schema is the migration
// MoveRuntimeProductStoresToPostgres2026111200000000; the stores write it
// with SQL (typeorm-publication.store.ts, typeorm-comment-slot.store.ts)
// for their atomic claims.

/**
 * One row per idempotency key: `runId:attempt:check`, `runId:attempt:comment`,
 * `runId:attempt:comment:<phase>`, `runId:attempt:check:awaiting_approval`,
 * `runId:attempt:reply:<suggestionId>`.
 */
@Entity('runtime_publications')
@Index('IDX_runtime_publications_run', ['organizationId', 'runId'])
@Index('IDX_runtime_publications_redrive', { synchronize: false })
export class RuntimePublicationModel {
    @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_runtime_publications' }) key: string;
    @Column('text', { name: 'run_id' }) runId: string;
    @Column('integer') attempt: number;
    @Column('text') kind: string;
    @Column('text', { name: 'organization_id' }) organizationId: string;
    @Column('text', { name: 'team_id' }) teamId: string;
    @Column('text', { name: 'repository_id' }) repositoryId: string;
    @Column('integer', { name: 'pr_number' }) prNumber: number;
    @Column('text', { name: 'head_sha' }) headSha: string;
    @Column('text') status: string;
    @Column('timestamptz', { name: 'lease_until', nullable: true }) leaseUntil: Date | null;
    @Column('integer', { name: 'check_rank', nullable: true }) checkRank: number | null;
    /** checkRunId, checkCreateFailures, comment, reason, fallback and redrive. */
    @Column('jsonb', { default: () => "'{}'" }) detail: Record<string, unknown>;
    /** A final publication's validated request, kept for a redrive. */
    @Column('jsonb', { nullable: true }) request: unknown | null;
    @Column('timestamptz', { name: 'created_at' }) createdAt: Date;
    @Column('timestamptz', { name: 'updated_at' }) updatedAt: Date;
}

/** The one Runtime comment of a pull request in one environment (environment_key), and the short lease a delivery holds while it creates or edits it. */
@Entity('runtime_pr_comments')
export class RuntimePullRequestCommentModel {
    @PrimaryColumn('text', { name: 'organization_id', primaryKeyConstraintName: 'PK_runtime_pr_comments' }) organizationId: string;
    @PrimaryColumn('text', { name: 'repository_id', primaryKeyConstraintName: 'PK_runtime_pr_comments' }) repositoryId: string;
    @PrimaryColumn('integer', { name: 'pr_number', primaryKeyConstraintName: 'PK_runtime_pr_comments' }) prNumber: number;
    /** '' for the environment the repository is the primary of; else its own (publish-environment.ts). */
    @PrimaryColumn('text', { name: 'environment_key', primaryKeyConstraintName: 'PK_runtime_pr_comments', default: '' }) environmentKey: string;
    @Column('text', { name: 'team_id' }) teamId: string;
    @Column('jsonb', { nullable: true }) comment: unknown | null;
    @Column('bigint', { name: 'comment_order', nullable: true }) commentOrder: number | null;
    @Column('boolean', { name: 'create_pending', nullable: true }) createPending: boolean | null;
    @Column('text', { name: 'lease_owner', nullable: true }) leaseOwner: string | null;
    @Column('timestamptz', { name: 'lease_until', nullable: true }) leaseUntil: Date | null;
    @Column('timestamptz', { name: 'updated_at' }) updatedAt: Date;
}

export const RUNTIME_PUBLICATION_MODELS = [RuntimePublicationModel, RuntimePullRequestCommentModel];
