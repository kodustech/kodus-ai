import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * One row per source doc the ingestion could not write. Kept indefinitely
 * so a code fix can drive a replay (separate tooling) without having to
 * re-scan Mongo.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'ingestion_errors' })
@Index('idx_ingestion_errors_source_created', ['source', 'createdAt'])
@Index('idx_ingestion_errors_pr', ['pullRequestId'])
@Index('idx_ingestion_errors_run', ['runId'])
export class IngestionErrorEntity {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ name: 'source', type: 'text' })
    source: string;

    @Column({ name: 'pull_request_id', type: 'text', nullable: true })
    pullRequestId: string | null;

    @Column({ name: 'organizationId', type: 'text', nullable: true })
    organizationId: string | null;

    @Column({ name: 'run_id', type: 'bigint', nullable: true })
    runId: string | null;

    @Column({
        name: 'created_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    createdAt: Date;

    @Column({ name: 'reason', type: 'text', nullable: true })
    reason: string | null;

    @Column({ name: 'error', type: 'text', nullable: true })
    error: string | null;

    @Column({ name: 'raw', type: 'jsonb', nullable: true })
    raw: Record<string, unknown> | null;
}
