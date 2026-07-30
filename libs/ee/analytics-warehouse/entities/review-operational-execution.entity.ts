import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Terminal code-review automation executions materialized for cockpit metrics.
 *
 * Ingested from operational Postgres into the analytics warehouse so cockpit
 * reads never hit OLTP tables directly.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'review_operational_executions' })
@Index('idx_review_ops_org_created', ['organizationId', 'createdAt'])
@Index('idx_review_ops_org_repo_created', [
    'organizationId',
    'repoFullName',
    'createdAt',
])
@Index('idx_review_ops_org_status_created', [
    'organizationId',
    'status',
    'createdAt',
])
export class ReviewOperationalExecutionEntity {
    @PrimaryColumn({ name: 'automation_execution_id', type: 'uuid' })
    automationExecutionId: string;

    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'team_id', type: 'uuid', nullable: true })
    teamId: string | null;

    @Column({ name: 'team_automation_id', type: 'uuid', nullable: true })
    teamAutomationId: string | null;

    @Column({ name: 'repositoryId', type: 'text', nullable: true })
    repositoryId: string | null;

    @Column({ name: 'repo_full_name', type: 'text', nullable: true })
    repoFullName: string | null;

    @Column({ name: 'pullRequestNumber', type: 'integer', nullable: true })
    pullRequestNumber: number | null;

    @Column({ name: 'status', type: 'text' })
    status: string;

    @Column({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @Column({ name: 'source_updated_at', type: 'timestamptz' })
    sourceUpdatedAt: Date;

    @Column({ name: 'ingested_at', type: 'timestamptz', default: () => 'now()' })
    ingestedAt: Date;
}
