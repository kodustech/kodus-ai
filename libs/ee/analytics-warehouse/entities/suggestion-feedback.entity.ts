import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { ANALYTICS_SCHEMA } from '../schema.constant';

/**
 * Thumbs up/down reactions on suggestion comments, one row per suggestion.
 * Ingested from Mongo `codeReviewFeedback`; counts are absolute snapshots
 * (the review pipeline re-reads reactions from the provider), so upserts
 * overwrite rather than accumulate.
 */
@Entity({ schema: ANALYTICS_SCHEMA, name: 'suggestion_feedback' })
@Index('idx_sugg_fb_org_created', ['organizationId', 'feedbackCreatedAt'])
export class SuggestionFeedbackEntity {
    @PrimaryColumn({ name: 'suggestion_id', type: 'text' })
    suggestionId: string;

    @Column({ name: 'organizationId', type: 'text' })
    organizationId: string;

    @Column({ name: 'thumbs_up', type: 'integer', default: 0 })
    thumbsUp: number;

    @Column({ name: 'thumbs_down', type: 'integer', default: 0 })
    thumbsDown: number;

    @Column({ name: 'comment_id', type: 'bigint', nullable: true })
    commentId: string | null;

    @Column({ name: 'pull_request_id', type: 'text', nullable: true })
    pullRequestId: string | null;

    @Column({ name: 'repo_full_name', type: 'text', nullable: true })
    repoFullName: string | null;

    @Column({ name: 'feedback_created_at', type: 'timestamptz', nullable: true })
    feedbackCreatedAt: Date | null;

    @Column({ name: 'source_updated_at', type: 'timestamptz', nullable: true })
    sourceUpdatedAt: Date | null;

    @Column({ name: 'ingested_at', type: 'timestamptz', default: () => 'now()' })
    ingestedAt: Date;
}
