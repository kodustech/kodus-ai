import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IFeaturedPublicReviewRepository } from '@libs/cli-review/domain/contracts/featured-public-review.repository.contract';
import { FeaturedPublicReviewModel } from './schemas/featured-public-review.model';

export type FeaturedPublicReviewListItem = Pick<
    FeaturedPublicReviewModel,
    'slug' | 'tags' | 'highlight' | 'prUrl' | 'pr' | 'sortOrder'
> & {
    issuesCount: number;
};

@Injectable()
export class FeaturedPublicReviewRepository
    implements IFeaturedPublicReviewRepository
{
    constructor(
        @InjectModel(FeaturedPublicReviewModel.name)
        private readonly model: Model<FeaturedPublicReviewModel>,
    ) {}

    async upsertBySlug(
        slug: string,
        data: Partial<FeaturedPublicReviewModel>,
    ): Promise<FeaturedPublicReviewModel> {
        const updated = await this.model
            .findOneAndUpdate(
                { slug },
                { $set: { ...data, slug } },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            )
            .lean<FeaturedPublicReviewModel>()
            .exec();
        if (!updated) {
            throw new Error(`Failed to upsert featured review ${slug}`);
        }
        return updated;
    }

    async findBySlug(
        slug: string,
    ): Promise<FeaturedPublicReviewModel | null> {
        return this.model
            .findOne({ slug, published: true })
            // Only the fields the public endpoint actually returns —
            // skip Mongo timestamps, sourceJobId and the internal flags
            // so we don't pay for unused bytes on every request.
            .select('slug tags highlight prUrl pr diff result')
            .lean<FeaturedPublicReviewModel>()
            .exec();
    }

    /**
     * Lightweight listing for the home grid — strips out the heavy
     * `diff` + full `result.issues[]` so the payload stays small enough
     * to be embedded in a WordPress page or cached in a CDN.
     */
    async listPublished(): Promise<FeaturedPublicReviewListItem[]> {
        const docs = await this.model
            .find({ published: true })
            .sort({ sortOrder: 1, createdAt: -1 })
            .select({
                slug: 1,
                tags: 1,
                highlight: 1,
                prUrl: 1,
                pr: 1,
                result: 1,
                sortOrder: 1,
                _id: 0,
            })
            .lean<
                Array<
                    Pick<
                        FeaturedPublicReviewModel,
                        | 'slug'
                        | 'tags'
                        | 'highlight'
                        | 'prUrl'
                        | 'pr'
                        | 'sortOrder'
                        | 'result'
                    >
                >
            >()
            .exec();

        return docs.map((doc) => {
            const issues =
                ((doc.result as { issues?: unknown[] })?.issues ?? []) as
                    unknown[];
            return {
                slug: doc.slug,
                tags: doc.tags,
                highlight: doc.highlight,
                prUrl: doc.prUrl,
                pr: doc.pr,
                sortOrder: doc.sortOrder,
                issuesCount: issues.length,
            };
        });
    }
}
