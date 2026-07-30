import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Materialized view of `pullRequests.files[].suggestions[]` exploded one
 * row per suggestion. Populated by the ingestion worker on upsert of the
 * parent PR.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'suggestions_mv' })
@Index('idx_sugg_mv_org_created', ['organizationId', 'suggestionCreatedAt'])
@Index('idx_sugg_mv_pr', ['pullRequestId'])
export class SuggestionMvEntity {
    @PrimaryColumn({ name: 'suggestion_id', type: 'text' })
    suggestionId: string;

    @Index()
    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'pullRequestId', type: 'text' })
    pullRequestId: string;

    @Column({ name: 'repositoryId', type: 'text', nullable: true })
    repositoryId: string | null;

    @Column({ name: 'filePath', type: 'text', nullable: true })
    filePath: string | null;

    @Column({ name: 'label', type: 'text', nullable: true })
    label: string | null;

    @Column({ name: 'severity', type: 'text', nullable: true })
    severity: string | null;

    @Column({
        name: 'suggestionDeliveryStatus',
        type: 'text',
        nullable: true,
    })
    suggestionDeliveryStatus: string | null;

    @Column({
        name: 'suggestionImplementationStatus',
        type: 'text',
        nullable: true,
    })
    suggestionImplementationStatus: string | null;

    @Column({
        name: 'suggestionCreatedAt',
        type: 'timestamptz',
        nullable: true,
    })
    suggestionCreatedAt: Date | null;

    /**
     * Kody Rule UUIDs this suggestion enforces — promoted from `raw` so
     * rule-level analytics can aggregate via GIN index.
     */
    @Column({
        name: 'brokenKodyRulesIds',
        type: 'text',
        array: true,
        nullable: true,
    })
    brokenKodyRulesIds: string[] | null;

    @Column({ name: 'raw', type: 'jsonb', nullable: true })
    raw: unknown;
}
