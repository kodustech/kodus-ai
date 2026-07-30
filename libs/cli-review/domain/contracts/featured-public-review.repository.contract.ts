import type { FeaturedPublicReviewListItem } from '@libs/cli-review/infrastructure/repositories/featured-public-review.repository';
import type { FeaturedPublicReviewModel } from '@libs/cli-review/infrastructure/repositories/schemas/featured-public-review.model';

export const FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN = Symbol.for(
    'FEATURED_PUBLIC_REVIEW_REPOSITORY_TOKEN',
);

export interface IFeaturedPublicReviewRepository {
    findBySlug(slug: string): Promise<FeaturedPublicReviewModel | null>;
    listPublished(): Promise<FeaturedPublicReviewListItem[]>;
}
