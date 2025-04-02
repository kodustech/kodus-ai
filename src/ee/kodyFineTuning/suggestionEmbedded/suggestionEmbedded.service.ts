import { Injectable } from "@nestjs/common";
import { ISuggestionEmbeddedService } from "../domain/suggestionEmbedded/contracts/suggestionEmbedded.service.contract";
import { SuggestionEmbeddedDatabaseRepository } from "../suggestionEmbedded.repository";
import { PinoLoggerService } from "@/core/infrastructure/adapters/services/logger/pino.service";
import { ISuggestionEmbedded } from "../domain/suggestionEmbedded/interfaces/suggestionEmbedded.interface";
import { SuggestionEmbeddedEntity } from "../domain/suggestionEmbedded/entities/suggestionEmbedded.entity";
import { ISuggestionToEmbed } from "@/core/domain/pullRequests/interfaces/pullRequests.interface";
import { FindManyOptions } from "typeorm";
import { CodeSuggestion } from "@/config/types/general/codeReview.type";
import { KodyFineTuningService } from "../kodyFineTuning.service";
import { getOpenAIEmbedding } from "@/shared/utils/langchainCommon/document";
import { FeedbackType } from "../domain/enums/feedbackType.enum";


export interface SuggestionEmbeddedFeedbacks {
    positiveFeedbacks: number;
    negativeFeedbacks: number;
    total: number;
}

export interface SuggestionEmbeddedFeedbacksWithLanguage {
    positiveFeedbacks: {
        language: {
            language: string;
            count: number;
        }[];
        total: number;
    };
    negativeFeedbacks: {
        language: {
            language: string;
            count: number;
        }[];
        total: number;
    };
    total: number;
}

@Injectable()
export class SuggestionEmbeddedService implements ISuggestionEmbeddedService {
    constructor(
        private readonly SuggestionEmbeddedRepository: SuggestionEmbeddedDatabaseRepository,
        private readonly logger: PinoLoggerService,
    ) {}

    create(
        entity: ISuggestionEmbedded,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        return this.SuggestionEmbeddedRepository.create(entity);
    }

    async bulkCreateFromMongoData(
        suggestions: ISuggestionToEmbed[],
    ): Promise<SuggestionEmbeddedEntity[] | undefined> {
        const SuggestionEmbeddeds = await Promise.all(
            suggestions
                .filter((suggestion) => suggestion?.id)
                .map(async (suggestion) => {
                    const suggestionEmbedded =
                        await this.embedSuggestionToSaveData(suggestion);
                    if (suggestionEmbedded) {
                        return this.SuggestionEmbeddedRepository.create(
                            suggestionEmbedded,
                        );
                    }
                }),
        );

        return SuggestionEmbeddeds.filter(
            (suggestion) => suggestion?.suggestionEmbed,
        );
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

    private tokenizeCode(code: string): string {
        return code
            .replace(/\s+/g, ' ') // Normalize spaces
            .replace(/[;,{}()[\]]/g, ' ') // Replace punctuation with spaces
            .replace(
                /\b(const|let|var|function|return|if|else|for|while)\b/g,
                '',
            ) // Remove common keywords
            .split(/\s+/)
            .filter(
                (token) =>
                    token.length > 2 &&
                    !['the', 'this', 'and', 'for'].includes(token),
            )
            .join(' ') // Remove short tokens and common words
            .toLowerCase()
            .trim();
    }

    private async embeddingText(suggestion: any): Promise<number[]> {
        if (
            !suggestion?.suggestionContent ||
            !suggestion?.label ||
            !suggestion?.improvedCode
        ) {
            return null;
        }

        const textToEmbed = `${suggestion.suggestionContent} ${suggestion.suggestionContent} ${suggestion.label} ${this.tokenizeCode(suggestion.improvedCode)}`;
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
}
