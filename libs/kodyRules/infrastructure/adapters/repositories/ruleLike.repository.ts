import { IRuleLikeRepository } from '@libs/kodyRules/domain/contracts/ruleLike.repository.contract';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { QueryFilter, Model } from 'mongoose';
import { RuleLikeModel } from './schemas/mongoose/rulesLikes.model';
import {
    RuleFeedbackType,
    RuleLikeEntity,
} from '@libs/kodyRules/domain/entities/ruleLike.entity';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';

@Injectable()
export class RuleLikesRepository implements IRuleLikeRepository {
    constructor(
        @InjectModel(RuleLikeModel.name)
        private readonly likeModel: Model<RuleLikeModel>,
    ) {}

    getNativeCollection() {
        return this.likeModel.db.collection('ruleLikes');
    }

    private async like(
        ruleId: string,
        language: string,
        userId?: string,
    ): Promise<RuleLikeEntity | null> {
        const res = await this.likeModel.updateOne(
            { ruleId, userId },
            { $setOnInsert: { language } },
            { upsert: true },
        );

        if (!res.upsertedId) return null;

        const doc = await this.likeModel.findById(res.upsertedId).exec();
        return mapSimpleModelToEntity(doc, RuleLikeEntity);
    }

    async unlike(ruleId: string, userId?: string): Promise<boolean> {
        const { deletedCount } = await this.likeModel.deleteOne({
            ruleId,
            userId,
        });
        return deletedCount > 0;
    }

    async setFeedback(
        ruleId: string,
        feedback: RuleFeedbackType,
        userId?: string,
    ): Promise<RuleLikeEntity | null> {
        const filter = userId
            ? { ruleId, userId }
            : { ruleId, userId: { $exists: false } };

        const res = await this.likeModel
            .findOneAndUpdate(
                filter,
                {
                    ruleId,
                    feedback,
                    userId,
                },
                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true,
                },
            )
            .exec();

        return mapSimpleModelToEntity(res, RuleLikeEntity);
    }

    async findOne(
        filter: QueryFilter<RuleLikeModel>,
    ): Promise<RuleLikeEntity | null> {
        const doc = await this.likeModel.findOne(filter).exec();
        return doc ? mapSimpleModelToEntity(doc, RuleLikeEntity) : null;
    }

    async find(filter?: QueryFilter<RuleLikeModel>): Promise<RuleLikeEntity[]> {
        const docs = await this.likeModel.find(filter).exec();
        return mapSimpleModelsToEntities(docs, RuleLikeEntity);
    }

    async countByRule(ruleId: string): Promise<number> {
        const [res] = await this.likeModel
            .aggregate([
                { $match: { ruleId } },
                { $group: { _id: '$ruleId', count: { $sum: 1 } } },
            ])
            .option({ maxTimeMS: MONGO_QUERY_MAX_TIME_MS })
            .exec();

        return res?.count ?? 0;
    }

    async topByLanguage(
        language: string,
        limit = 10,
    ): Promise<{ ruleId: string; count: number }[]> {
        return this.likeModel
            .aggregate([
                { $match: { language } },
                { $group: { _id: '$ruleId', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: limit },
                { $project: { _id: 0, ruleId: '$_id', count: 1 } },
            ])
            .option({ maxTimeMS: MONGO_QUERY_MAX_TIME_MS })
            .exec();
    }

    async getAllLikes(): Promise<RuleLikeEntity[]> {
        const docs = await this.likeModel.find().exec();
        return mapSimpleModelsToEntities(docs, RuleLikeEntity);
    }

    async getAllRulesWithFeedback(userId?: string): Promise<
        {
            ruleId: string;
            positiveCount: number;
            negativeCount: number;
            userFeedback: RuleFeedbackType | null;
        }[]
    > {
        const pipeline = [
            {
                $group: {
                    _id: '$ruleId',
                    positiveCount: {
                        $sum: {
                            $cond: [{ $eq: ['$feedback', 'positive'] }, 1, 0],
                        },
                    },
                    negativeCount: {
                        $sum: {
                            $cond: [{ $eq: ['$feedback', 'negative'] }, 1, 0],
                        },
                    },
                    userFeedback: {
                        $max: {
                            // Use $max em vez de $first para garantir um resultado determinístico
                            $cond: [
                                { $eq: ['$userId', userId] },
                                '$feedback',
                                null,
                            ],
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    ruleId: '$_id',
                    positiveCount: 1,
                    negativeCount: 1,
                    userFeedback: 1,
                },
            },
        ];

        return this.likeModel
            .aggregate(pipeline)
            .option({ maxTimeMS: MONGO_QUERY_MAX_TIME_MS })
            .exec();
    }
}
