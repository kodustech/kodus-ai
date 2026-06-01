import { Column, Entity, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Per-table ingestion checkpoint. The worker reads source rows where
 * `source_updated_at > lastSourceUpdatedAt` and advances the watermark on
 * successful batch write. Idempotent on restart.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'watermarks' })
export class IngestionWatermarkEntity {
    @PrimaryColumn({ name: 'table_name', type: 'text' })
    tableName: string;

    @Column({
        name: 'last_source_updated_at',
        type: 'timestamptz',
        nullable: true,
    })
    lastSourceUpdatedAt: Date | null;

    @Column({ name: 'last_source_id', type: 'text', nullable: true })
    lastSourceId: string | null;

    @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
    lastRunAt: Date | null;

    @Column({ name: 'last_status', type: 'text', nullable: true })
    lastStatus: string | null;

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError: string | null;
}
