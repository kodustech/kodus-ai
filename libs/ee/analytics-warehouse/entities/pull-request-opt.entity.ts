import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Wide optimized view of a pull request. Ingested from Mongo `pullRequests`.
 * Timestamps are parsed on write so cockpit queries never cast on read.
 *
 * `files` keeps the embedded raw structure — we *also* explode it into
 * `suggestions_mv` for direct query, but some reports (e.g. counts by file
 * type) still want the nested shape.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'pull_requests_opt' })
@Index('idx_pr_opt_org_closed', ['organizationId', 'parsedClosedAt'])
@Index('idx_pr_opt_org_created', ['organizationId', 'parsedCreatedAt'])
@Index('idx_pr_opt_org_repo', ['organizationId', 'repoFullName'])
export class PullRequestOptEntity {
    @PrimaryColumn({ name: '_id', type: 'text' })
    id: string;

    @Index()
    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'repo_full_name', type: 'text', nullable: true })
    repoFullName: string | null;

    @Column({ name: 'repositoryId', type: 'text', nullable: true })
    repositoryId: string | null;

    /** Provider-facing PR number — used for "view on PR" deep links. */
    @Column({ name: 'pr_number', type: 'integer', nullable: true })
    prNumber: number | null;

    @Column({ type: 'text', nullable: true })
    status: string | null;

    @Column({ name: 'authorId', type: 'text', nullable: true })
    authorId: string | null;

    @Column({ name: 'author_username', type: 'text', nullable: true })
    authorUsername: string | null;

    @Column({ name: 'totalChanges', type: 'integer', nullable: true })
    totalChanges: number | null;

    @Column({ name: 'createdAt', type: 'text', nullable: true })
    createdAtRaw: string | null;

    @Column({ name: 'openedAt', type: 'text', nullable: true })
    openedAtRaw: string | null;

    @Column({ name: 'closedAt', type: 'text', nullable: true })
    closedAtRaw: string | null;

    @Column({ name: 'parsed_created_at', type: 'timestamptz', nullable: true })
    parsedCreatedAt: Date | null;

    @Column({ name: 'parsed_opened_at', type: 'timestamptz', nullable: true })
    parsedOpenedAt: Date | null;

    @Column({ name: 'parsed_closed_at', type: 'timestamptz', nullable: true })
    parsedClosedAt: Date | null;

    @Column({ type: 'jsonb', nullable: true })
    files: unknown;

    @Column({ type: 'jsonb', nullable: true })
    commits: unknown;

    @Column({ name: 'ingested_at', type: 'timestamptz', default: () => 'now()' })
    ingestedAt: Date;

    @Column({ name: 'source_updated_at', type: 'timestamptz', nullable: true })
    sourceUpdatedAt: Date | null;
}
