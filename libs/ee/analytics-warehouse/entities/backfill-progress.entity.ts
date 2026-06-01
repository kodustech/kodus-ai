import { Column, Entity, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Checkpoint for the chunked backfill CLI. `cursorAt` is the upper bound
 * (exclusive) of the last completed window, by source `createdAt`. On
 * resume the CLI picks up from here.
 *
 * Auxiliary: dropping this table just means the next backfill starts from
 * scratch — the warehouse rows themselves stay intact (UPSERT is idempotent).
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'backfill_progress' })
export class BackfillProgressEntity {
    @PrimaryColumn({ name: 'source', type: 'text' })
    source: string;

    @Column({ name: 'cursor_at', type: 'timestamptz' })
    cursorAt: Date;

    @Column({ name: 'status', type: 'text' })
    status: string;

    @Column({
        name: 'started_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    startedAt: Date;

    @Column({
        name: 'updated_at',
        type: 'timestamptz',
        default: () => 'now()',
    })
    updatedAt: Date;

    @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
    finishedAt: Date | null;

    @Column({ name: 'scanned_total', type: 'bigint', default: 0 })
    scannedTotal: string;

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError: string | null;

    @Column({ name: 'params', type: 'jsonb', nullable: true })
    params: Record<string, unknown> | null;
}
