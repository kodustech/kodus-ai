import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Snapshot of a public PR review that we want to surface as a "featured
 * example" on try.kodus.io and the kodus.io WordPress site. Decoupled
 * from the workflow_jobs queue so old jobs can be garbage collected
 * without losing the demo content.
 *
 * Curation is manual — a maintainer runs a script that picks a
 * completed jobId, snapshots it into this collection, and assigns a
 * stable URL-safe slug.
 */
@Schema({
    collection: 'featured_public_reviews',
    timestamps: { createdAt: true, updatedAt: true },
})
export class FeaturedPublicReviewModel {
    /**
     * URL-safe identifier (e.g. `vercel-nextjs-93759`). The whole
     * public API is keyed on slug so URLs stay readable and shareable.
     */
    @Prop({ type: String, required: true, unique: true, index: true })
    slug: string;

    /** Whether the entry shows up in the public listing. Lets us draft
     * an entry, review it, then flip it on. */
    @Prop({ type: Boolean, required: true, default: true, index: true })
    published: boolean;

    /** Sort order on the home grid — lower comes first. Optional. */
    @Prop({ type: Number, required: false })
    sortOrder?: number;

    /** Free-form labels for filtering on the WP / try home (e.g.
     *  ["typescript", "bug", "framework"]). */
    @Prop({ type: [String], required: true, default: [] })
    tags: string[];

    /** Optional one-line copy to display alongside the card ("Spot the
     *  Suspense ordering bug Vercel shipped last week"). */
    @Prop({ type: String, required: false })
    highlight?: string;

    /** Original PR URL, kept for traceability and as a fallback target. */
    @Prop({ type: String, required: true })
    prUrl: string;

    /** PR metadata as fetched from GitHub at curation time. We don't
     *  refetch — featured examples are intentionally a frozen snapshot
     *  so the demo never regresses if upstream renames branches /
     *  closes the PR. */
    @Prop({ type: Object, required: true })
    pr: Record<string, unknown>;

    /** Raw unified diff. Mongo doc max is 16MB, our cap upstream is
     *  ~500KB worth of diff, so we're nowhere near the ceiling. */
    @Prop({ type: String, required: true })
    diff: string;

    /** CliReviewResponse — { summary, issues, filesAnalyzed, duration }. */
    @Prop({ type: Object, required: true })
    result: Record<string, unknown>;

    /** Track which jobId produced this snapshot in case we want to
     *  re-promote / replace later. */
    @Prop({ type: String, required: false })
    sourceJobId?: string;
}

export type FeaturedPublicReviewDocument = HydratedDocument<
    FeaturedPublicReviewModel
>;

export const FeaturedPublicReviewSchema = SchemaFactory.createForClass(
    FeaturedPublicReviewModel,
);
