import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Exploded commits from `pullRequests.commits[]`. One row per (pr, commit).
 * `commit_timestamp` is pre-parsed to a real timestamp so cockpit queries
 * don't need SAFE_CAST on every read.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'commits_view' })
@Index('idx_commits_view_org_ts', ['organizationId', 'commitTimestamp'])
@Index('idx_commits_view_pr', ['pullRequestId'])
export class CommitsViewEntity {
    @PrimaryColumn({ name: 'pull_request_id', type: 'text' })
    pullRequestId: string;

    @PrimaryColumn({ name: 'commit_hash', type: 'text' })
    commitHash: string;

    @Index()
    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'commit_timestamp', type: 'timestamptz', nullable: true })
    commitTimestamp: Date | null;

    @Column({ name: 'commit_timestamp_raw', type: 'text', nullable: true })
    commitTimestampRaw: string | null;

    @Column({ name: 'author_username', type: 'text', nullable: true })
    authorUsername: string | null;

    @Column({ name: 'raw', type: 'jsonb', nullable: true })
    raw: unknown;
}
