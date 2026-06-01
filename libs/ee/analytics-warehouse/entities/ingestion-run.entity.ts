import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * One row per ingestion attempt — incremental cron, backfill window, replay.
 * Auxiliary table: losing it never corrupts the warehouse, but ops loses
 * the ability to grep history / alert on lag.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'ingestion_runs' })
@Index('idx_ingestion_runs_started', ['source', 'startedAt'])
@Index('idx_ingestion_runs_status', ['status', 'finishedAt'])
export class IngestionRunEntity {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ name: 'source', type: 'text' })
    source: string;

    @Column({ name: 'mode', type: 'text' })
    mode: string;

    @Column({
        name: 'started_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    startedAt: Date;

    @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
    finishedAt: Date | null;

    @Column({ name: 'status', type: 'text' })
    status: string;

    @Column({ name: 'scanned', type: 'integer', default: 0 })
    scanned: number;

    @Column({ name: 'prs_upserted', type: 'integer', default: 0 })
    prsUpserted: number;

    @Column({ name: 'suggestions_inserted', type: 'integer', default: 0 })
    suggestionsInserted: number;

    @Column({ name: 'commits_inserted', type: 'integer', default: 0 })
    commitsInserted: number;

    @Column({ name: 'errors_quarantined', type: 'integer', default: 0 })
    errorsQuarantined: number;

    @Column({ name: 'mongo_ms', type: 'integer', nullable: true })
    mongoMs: number | null;

    @Column({ name: 'write_ms', type: 'integer', nullable: true })
    writeMs: number | null;

    @Column({ name: 'since', type: 'timestamptz', nullable: true })
    since: Date | null;

    @Column({ name: 'until', type: 'timestamptz', nullable: true })
    until: Date | null;

    @Column({ name: 'organizationId', type: 'text', nullable: true })
    organizationId: string | null;

    @Column({ name: 'new_watermark', type: 'timestamptz', nullable: true })
    newWatermark: Date | null;

    @Column({ name: 'error', type: 'text', nullable: true })
    error: string | null;
}
