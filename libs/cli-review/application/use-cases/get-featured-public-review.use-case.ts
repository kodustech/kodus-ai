import { Inject, Injectable } from '@nestjs/common';
import {
    IFeaturedPublicReviewRepository,
    FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN,
} from '@libs/cli-review/domain/contracts/featured-public-review.repository.contract';

export interface GetFeaturedPublicReviewInput {
    slug: string;
}

export interface GetFeaturedPublicReviewResult {
    slug: string;
    tags: string[];
    highlight?: string;
    prUrl: string;
    pr: Record<string, unknown>;
    diff: string;
    result: unknown;
}

/**
 * Fetches a single curated review snapshot by slug. Returns `null`
 * when the slug doesn't exist or is unpublished — the controller
 * adapts that to a 404 so the use case stays HTTP-agnostic.
 */
@Injectable()
export class GetFeaturedPublicReviewUseCase {
    constructor(
        @Inject(FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN)
        private readonly featuredPublicReviewRepository: IFeaturedPublicReviewRepository,
    ) {}

    async execute(
        input: GetFeaturedPublicReviewInput,
    ): Promise<GetFeaturedPublicReviewResult | null> {
        const doc =
            await this.featuredPublicReviewRepository.findBySlug(input.slug);
        if (!doc) return null;
        return {
            slug: doc.slug,
            tags: doc.tags,
            highlight: doc.highlight,
            prUrl: doc.prUrl,
            pr: doc.pr as Record<string, unknown>,
            diff: doc.diff,
            result: doc.result,
        };
    }
}
