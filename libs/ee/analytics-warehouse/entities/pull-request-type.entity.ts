import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * PR classification (e.g. "Bug Fix", "Feature"). One row per PR.
 * Populated by the ingestion worker from Mongo.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'pull_request_types' })
export class PullRequestTypeEntity {
    @PrimaryColumn({ name: 'pullRequestId', type: 'text' })
    pullRequestId: string;

    @Index()
    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'type', type: 'text', nullable: true })
    type: string | null;
}
