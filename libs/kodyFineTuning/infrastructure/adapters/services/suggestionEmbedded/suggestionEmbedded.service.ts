import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { FindManyOptions } from 'typeorm';

import { ISuggestionToEmbed } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { KodyFineTuningService } from '../kodyFineTuning.service';
import { ISuggestionEmbeddedService } from '@libs/kodyFineTuning/domain/suggestionEmbedded/contracts/suggestionEmbedded.service.contract';
import {
    ISuggestionEmbedded,
    SuggestionEmbeddedFeedbacks,
    SuggestionEmbeddedFeedbacksWithLanguage,
} from '@libs/kodyFineTuning/domain/suggestionEmbedded/interfaces/suggestionEmbedded.interface';
import { SuggestionEmbeddedEntity } from '@libs/kodyFineTuning/domain/suggestionEmbedded/entities/suggestionEmbedded.entity';
import { getOpenAIEmbedding } from '@libs/common/utils/langchainCommon/document';
import { FeedbackType } from '@libs/kodyFineTuning/domain/enums/feedbackType.enum';
import { SuggestionEmbeddedDatabaseRepository } from '../../repositories/suggestionEmbedded.repository';

const UUID_REGEX =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class SuggestionEmbeddedService implements ISuggestionEmbeddedService {
    private readonly logger = createLogger(SuggestionEmbeddedService.name);
    constructor(
        private readonly SuggestionEmbeddedRepository: SuggestionEmbeddedDatabaseRepository,
    ) {}

    bulkInsert(
        entities: ISuggestionEmbedded[],
    ): Promise<SuggestionEmbeddedEntity[] | undefined> {
        return this.SuggestionEmbeddedRepository.bulkInsert(entities);
    }

    create(
        entity: ISuggestionEmbedded,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        return this.SuggestionEmbeddedRepository.create(entity);
    }

    async bulkCreateFromMongoData(
        suggestions: ISuggestionToEmbed[],
    ): Promise<SuggestionEmbeddedEntity[] | undefined> {
        const cleanSuggestions = suggestions.filter(this.isValidSuggestion);

        if (cleanSuggestions.length === 0) {
            return [];
        }

        const allResults = await Promise.all(
            cleanSuggestions.map((suggestion) =>
                this.embedSuggestionToSaveData(suggestion),
            ),
        );

        const toInsert: ISuggestionEmbedded[] = allResults.filter(
            (x): x is ISuggestionEmbedded => !!x,
        );

        const insertedEntities = await this.bulkInsert(toInsert);

        return insertedEntities;
    }

    async find(
        filter?: Omit<Partial<ISuggestionEmbedded>, 'suggestionId'>,
        options?: FindManyOptions,
    ): Promise<SuggestionEmbeddedEntity[]> {
        return this.SuggestionEmbeddedRepository.find(filter, options);
    }

    async findOne(
        suggestionId: string,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        return this.SuggestionEmbeddedRepository.findOne(suggestionId);
    }

    async findById(
        uuid: string,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        return this.SuggestionEmbeddedRepository.findById(uuid);
    }

    async getByOrganization(
        organizationId: string,
    ): Promise<SuggestionEmbeddedFeedbacks> {
        const result = await this.SuggestionEmbeddedRepository.find({
            organization: {
                uuid: organizationId,
            },
        });

        return await this.countFeedbacks(result);
    }

    async getByRepositoryAndOrganization(
        repositoryId: string,
        organizationId: string,
    ): Promise<SuggestionEmbeddedFeedbacks> {
        const result = await this.SuggestionEmbeddedRepository.find({
            repositoryId,
            organization: {
                uuid: organizationId,
            },
        });

        return await this.countFeedbacks(result);
    }

    async getByOrganizationWithLanguages(
        organizationId: string,
    ): Promise<SuggestionEmbeddedFeedbacksWithLanguage> {
        const result = await this.SuggestionEmbeddedRepository.find({
            organization: {
                uuid: organizationId,
            },
        });

        return await this.countWithLanguages(result);
    }

    async getByRepositoryAndOrganizationWithLanguages(
        repositoryId: string,
        organizationId: string,
    ): Promise<SuggestionEmbeddedFeedbacksWithLanguage> {
        const result = await this.SuggestionEmbeddedRepository.find({
            repositoryId,
            organization: {
                uuid: organizationId,
            },
        });

        return await this.countWithLanguages(result);
    }

    async update(
        filter: Partial<ISuggestionEmbedded>,
        data: Partial<ISuggestionEmbedded>,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        return this.SuggestionEmbeddedRepository.update(filter, data);
    }

    async findByLanguage(
        language: string,
    ): Promise<SuggestionEmbeddedEntity[]> {
        return this.SuggestionEmbeddedRepository.find({ language });
    }

    async findByFeedbackType(
        feedbackType: string,
    ): Promise<SuggestionEmbeddedEntity[]> {
        return this.SuggestionEmbeddedRepository.find({ feedbackType });
    }

    public async embedSuggestionsForISuggestionToEmbed(
        codeSuggestions: Partial<CodeSuggestion>[],
        organizationId: string,
        prNumber: number,
        repositoryId: string,
        repositoryFullName: string,
    ): Promise<ISuggestionToEmbed[]> {
        try {
            const embeddedSuggestions: ISuggestionToEmbed[] = [];
            for (const suggestion of codeSuggestions) {
                try {
                    const embeddedSuggestion =
                        await this.embeddingText(suggestion);

                    if (!embeddedSuggestion) {
                        continue;
                    }

                    embeddedSuggestions.push({
                        ...suggestion,
                        suggestionEmbed: embeddedSuggestion,
                        organizationId: organizationId,
                        pullRequest: {
                            number: prNumber,
                            repository: {
                                id: repositoryId,
                                fullName: repositoryFullName,
                            },
                        },
                    });
                } catch (error) {
                    this.logger.error({
                        message: 'Error generating embedding',
                        error,
                        context: KodyFineTuningService.name,
                        metadata: {
                            suggestionId: suggestion?.id,
                            organizationId: organizationId,
                            pullRequestNumber: prNumber,
                            repositoryName: repositoryFullName,
                        },
                    });
                }
            }

            return embeddedSuggestions;
        } catch (error) {
            this.logger.error({
                message: 'Error in embedSuggestionsData',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    dataLength: codeSuggestions?.length,
                },
            });
            throw error;
        }
    }

    private async embedSuggestionToSaveData(
        suggestion: ISuggestionToEmbed,
    ): Promise<ISuggestionEmbedded> {
        if (
            !suggestion.suggestionContent ||
            !suggestion.oneSentenceSummary ||
            !suggestion.label ||
            !suggestion.severity ||
            !suggestion.feedbackType
        ) {
            return null;
        }

        const embeddingResult = await this.embeddingText(suggestion);

        if (!embeddingResult) {
            return null;
        }

        return {
            suggestionId: suggestion.id,
            suggestionEmbed: embeddingResult,
            pullRequestNumber: suggestion.pullRequest.number,
            repositoryId: suggestion.pullRequest.repository.id,
            repositoryFullName: suggestion.pullRequest.repository.fullName,
            organization: {
                uuid: suggestion.organizationId,
            },
            label: suggestion.label,
            severity: suggestion.severity,
            feedbackType: suggestion.feedbackType,
            improvedCode: suggestion.improvedCode,
            suggestionContent: suggestion.suggestionContent,
            language: suggestion.language?.toLowerCase(),
        };
    }

    private async embeddingText(suggestion: any): Promise<number[]> {
        if (
            !suggestion?.suggestionContent ||
            !suggestion?.oneSentenceSummary ||
            !suggestion?.label
        ) {
            return null;
        }

        const textToEmbed = `${suggestion.suggestionContent} ${suggestion.oneSentenceSummary} ${suggestion.label}`;
        const result = await getOpenAIEmbedding(textToEmbed);
        return result?.data[0]?.embedding;
    }

    private async countFeedbacks(
        suggestions: SuggestionEmbeddedEntity[],
    ): Promise<SuggestionEmbeddedFeedbacks> {
        const positiveFeedback = suggestions.filter(
            (suggestion) =>
                suggestion.feedbackType === FeedbackType.POSITIVE_REACTION ||
                suggestion.feedbackType === FeedbackType.SUGGESTION_IMPLEMENTED,
        );

        const negativeFeedback = suggestions.filter(
            (suggestion) =>
                suggestion.feedbackType === FeedbackType.NEGATIVE_REACTION,
        );

        return {
            positiveFeedbacks: positiveFeedback.length,
            negativeFeedbacks: negativeFeedback.length,
            total: suggestions.length,
        };
    }

    private async countWithLanguages(result: SuggestionEmbeddedEntity[]) {
        const positiveFeedbacks = result.filter(
            (suggestion) =>
                suggestion.feedbackType === FeedbackType.POSITIVE_REACTION ||
                suggestion.feedbackType === FeedbackType.SUGGESTION_IMPLEMENTED,
        );
        const negativeFeedbacks = result.filter(
            (suggestion) =>
                suggestion.feedbackType === FeedbackType.NEGATIVE_REACTION,
        );

        const positiveLanguagesCount = positiveFeedbacks.reduce(
            (acc, suggestion) => {
                const language = suggestion.language;
                if (!language) return acc;

                if (!acc[language]) {
                    acc[language] = 1;
                } else {
                    acc[language]++;
                }
                return acc;
            },
            {},
        );

        const negativeLanguagesCount = negativeFeedbacks.reduce(
            (acc, suggestion) => {
                const language = suggestion.language;
                if (!language) return acc;

                if (!acc[language]) {
                    acc[language] = 1;
                } else {
                    acc[language]++;
                }
                return acc;
            },
            {},
        );

        return {
            positiveFeedbacks: {
                language: Object.entries(positiveLanguagesCount).map(
                    ([language, count]) => ({
                        language,
                        count: count as number,
                    }),
                ),
                total: positiveFeedbacks.length,
            },
            negativeFeedbacks: {
                language: Object.entries(negativeLanguagesCount).map(
                    ([language, count]) => ({
                        language,
                        count: count as number,
                    }),
                ),
                total: negativeFeedbacks.length,
            },
            total: result.length,
        };
    }

    private isValidSuggestion(
        s: ISuggestionToEmbed | null | undefined,
    ): s is ISuggestionToEmbed {
        return (
            !!s &&
            typeof s.id === 'string' &&
            UUID_REGEX.test(s.id) &&
            !!s.suggestionContent &&
            !!s.oneSentenceSummary &&
            !!s.label &&
            !!s.severity &&
            !!s.feedbackType
        );
    }
}
