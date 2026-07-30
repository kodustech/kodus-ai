import { Inject, Injectable } from '@nestjs/common';
import type { FeaturedPublicReviewListItem } from '@libs/cli-review/infrastructure/repositories/featured-public-review.repository';
import {
    IFeaturedPublicReviewRepository,
    FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN,
} from '@libs/cli-review/domain/contracts/featured-public-review.repository.contract';

/**
 * Reads the curated home-grid list. Pulled out of the controller so
 * the HTTP layer stays a thin transport adapter and we can reuse the
 * same fetch from scripts/tests without spinning up Nest's HTTP stack.
 */
@Injectable()
export class ListFeaturedPublicReviewsUseCase {
    constructor(
        @Inject(FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN)
        private readonly featuredPublicReviewRepository: IFeaturedPublicReviewRepository,
    ) {}

    async execute(): Promise<{ items: FeaturedPublicReviewListItem[] }> {
        const items =
            await this.featuredPublicReviewRepository.listPublished();
        return { items };
    }
}
