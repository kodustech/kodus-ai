import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ICodeReviewFeedbackRepository } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import {
    ICodeReviewFeedback,
    ICollectedReaction,
} from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { CodeReviewFeedbackEntity } from '@libs/code-review/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { CodeReviewFeedbackModel } from './schemas/mongoose/codeReviewFeedback.model';

@Injectable()
export class CodeReviewFeedbackRepository implements ICodeReviewFeedbackRepository {
    private readonly logger = createLogger(CodeReviewFeedbackRepository.name);

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

    async bulkUpsertReactions(
        reactions: ICollectedReaction[],
    ): Promise<number> {
        if (!reactions?.length) {
            return 0;
        }

        const operations = reactions.map((reaction) => ({
            updateOne: {
                filter: {
                    organizationId: reaction.organizationId,
                    suggestionId: reaction.suggestionId,
                },
                update: {
                    $set: {
                        reactions: reaction.reactions,
                        comment: reaction.comment,
                        pullRequest: reaction.pullRequest,
                    },
                    // Only on insert: an existing row may already have been
                    // flagged as embedded, and refreshing a thumbs count must
                    // not silently undo that.
                    $setOnInsert: { syncedEmbeddedSuggestions: false },
                },
                upsert: true,
            },
        }));

        try {
            // Unordered: one rejected document should not stop the reactions
            // queued behind it. Mongo applies everything it can and reports
            // the rest together.
            const result = await this.codeReviewFeedbackModel.bulkWrite(
                operations,
                { ordered: false },
            );

            return (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
        } catch (error) {
            // A partially applied write still applied something. Without the
            // counts below you cannot tell "nothing was saved" from "most of
            // it was saved and three documents were rejected".
            const partialResult = error?.result ?? {};
            const writeErrors: any[] = error?.writeErrors ?? [];

            this.logger.error({
                message: 'Failed to upsert code review reactions',
                context: CodeReviewFeedbackRepository.name,
                error,
                metadata: {
                    organizationId: reactions[0]?.organizationId,
                    operations: operations.length,
                    upserted: partialResult.upsertedCount ?? 0,
                    modified: partialResult.modifiedCount ?? 0,
                    failed: writeErrors.length,
                    // Codes and positions only — the rejected documents carry
                    // customer content and have no place in a log line.
                    failureCodes: [
                        ...new Set(
                            writeErrors.map((writeError) => writeError?.code),
                        ),
                    ],
                    firstFailedSuggestionId:
                        reactions[writeErrors[0]?.index]?.suggestionId,
                },
            });

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
        repositoryId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]> {
        try {
            const filter: any = {
                organizationId,
            };

            if (syncedEmbeddedSuggestions !== undefined) {
                filter.syncedEmbeddedSuggestions = {
                    $ne: !syncedEmbeddedSuggestions,
                };
            }

            if (repositoryId) {
                filter['pullRequest.repository.id'] = repositoryId;
            }

            const docs = await this.codeReviewFeedbackModel.find(filter).exec();

            return mapSimpleModelsToEntities(docs, CodeReviewFeedbackEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async updateSyncedSuggestionsFlag(
        organizationId: string,
        suggestionIds: string[],
        syncedEmbeddedSuggestions: boolean,
    ): Promise<void> {
        try {
            const validIds = suggestionIds.filter(
                (id) => typeof id === 'string' && id.length > 0,
            );
            if (validIds.length === 0) {
                return null;
            }

            const filter = {
                organizationId: organizationId,
                suggestionId: { $in: validIds },
            };

            const update = {
                $set: { syncedEmbeddedSuggestions: syncedEmbeddedSuggestions },
            };

            await this.codeReviewFeedbackModel.updateMany(filter, update);
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
