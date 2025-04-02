import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { CodeReviewFeedbackModel } from './schema/codeReviewFeedback.model';
import { ICodeReviewFeedbackRepository } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { ICodeReviewFeedback } from '@/core/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { CodeReviewFeedbackEntity } from '@/core/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';

@Injectable()
export class CodeReviewFeedbackRepository
    implements ICodeReviewFeedbackRepository
{
    constructor(
        @InjectModel(CodeReviewFeedbackModel.name)
        private readonly codeReviewFeedbackModel: Model<CodeReviewFeedbackModel>,
    ) {}

    async create(
        codeReviewFeedback: ICodeReviewFeedback,
    ): Promise<CodeReviewFeedbackEntity> {
        try {
            const codeReviewFeedbackSaved =
                await this.codeReviewFeedbackModel.create(codeReviewFeedback);

            return mapSimpleModelToEntity(
                codeReviewFeedbackSaved,
                CodeReviewFeedbackEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async bulkCreate(
        feedbacks: Omit<ICodeReviewFeedback, 'uuid'>[],
    ): Promise<CodeReviewFeedbackEntity[]> {
        try {
            const savedFeedbacks =
                await this.codeReviewFeedbackModel.insertMany(feedbacks);

            return savedFeedbacks.map((feedback) =>
                mapSimpleModelToEntity(feedback, CodeReviewFeedbackEntity),
            );
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    async findById(uuid: string): Promise<CodeReviewFeedbackEntity | null> {
        try {
            const codeReviewFeedback = await this.codeReviewFeedbackModel
                .findOne({ uuid })
                .exec();

            return codeReviewFeedback
                ? mapSimpleModelToEntity(
                      codeReviewFeedback,
                      CodeReviewFeedbackEntity,
                  )
                : null;
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(
        filter?: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity> {
        try {
            const codeReviewFeedback = await this.codeReviewFeedbackModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(
                codeReviewFeedback,
                CodeReviewFeedbackEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity[]> {
        try {
            const codeReviewFeedbacks = await this.codeReviewFeedbackModel
                .find(filter)
                .exec();

            return mapSimpleModelsToEntities(
                codeReviewFeedbacks,
                CodeReviewFeedbackEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findByOrganizationAndSyncedFlag(
        organizationId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]> {
        try {
            const filter: any = {
                organizationId,
            };

            if (syncedEmbeddedSuggestions !== undefined) {
                filter['$or'] = [
                    { syncedEmbeddedSuggestions },
                    { syncedEmbeddedSuggestions: { $exists: false } },
                ];
            }

            const docs = await this.codeReviewFeedbackModel.find(filter).exec();

            return mapSimpleModelsToEntities(docs, CodeReviewFeedbackEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async updateSyncedSuggestionsFlag(
        organizationId: string,
        syncedEmbeddedSuggestions: boolean,
        suggestionId: string,
    ): Promise<CodeReviewFeedbackEntity | null> {
        try {
            const doc = await this.codeReviewFeedbackModel.findOneAndUpdate(
                {
                    suggestionId: suggestionId,
                    organizationId: organizationId,
                },
                {
                    $set: {
                        syncedEmbeddedSuggestions: syncedEmbeddedSuggestions,
                    },
                },
                { new: true },
            );

            return doc
                ? mapSimpleModelToEntity(doc, CodeReviewFeedbackEntity)
                : null;
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.codeReviewFeedbackModel.db.collection(
                    'codeReviewFeedback',
                );

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }
}
