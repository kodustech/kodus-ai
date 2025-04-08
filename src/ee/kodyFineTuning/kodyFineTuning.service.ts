import {
    CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
    ICodeReviewFeedbackService,
} from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { ICodeReviewFeedback } from '@/core/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';

import {
    PULL_REQUESTS_SERVICE_TOKEN,
    IPullRequestsService,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import {
    IPullRequests,
    ISuggestionToEmbed,
} from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { Injectable, Inject } from '@nestjs/common';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import {
    CodeSuggestion,
    Repository,
} from '@/config/types/general/codeReview.type';

import { kmeans } from 'ml-kmeans';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { FeedbackType } from './domain/enums/feedbackType.enum';
import { IClusterizedSuggestion } from './domain/interfaces/kodyFineTuning.interface';
import { FineTuningType } from './domain/enums/fineTuningType.enum';
import { FineTuningDecision } from './domain/enums/fineTuningDecision.enum';
import {
    ISuggestionEmbeddedService,
    SUGGESTION_EMBEDDED_SERVICE_TOKEN,
} from './domain/suggestionEmbedded/contracts/suggestionEmbedded.service.contract';
import { IGlobalParametersService } from '@/core/domain/global-parameters/contracts/global-parameters.service.contract';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/global-parameters/contracts/global-parameters.service.contract';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';
import { ISuggestionEmbedded } from './domain/suggestionEmbedded/interfaces/suggestionEmbedded.interface';
@Injectable()
export class KodyFineTuningService {
    private readonly MAX_CLUSTERS = 50;
    private readonly DIVISOR_FOR_CLUSTER_QUANTITY = 2;
    private readonly SIMILARITY_THRESHOLD_NEGATIVE = 0.75;
    private readonly SIMILARITY_THRESHOLD_POSITIVE = 0.75;

    constructor(
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(CODE_REVIEW_FEEDBACK_SERVICE_TOKEN)
        private readonly codeReviewFeedbackService: ICodeReviewFeedbackService,

        @Inject(SUGGESTION_EMBEDDED_SERVICE_TOKEN)
        private readonly suggestionEmbeddedService: ISuggestionEmbeddedService,

        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParametersService: IGlobalParametersService,

        private readonly logger: PinoLoggerService,
    ) {}

    public async startAnalysis(
        organizationId: string,
        repository: { id: string; full_name: string },
        prNumber: number,
        language?: string,
    ): Promise<IClusterizedSuggestion[]> {
        const embeddedSuggestions: Partial<CodeSuggestion>[] = [];
        let suggestions: Partial<CodeSuggestion>[] = [];

        await this.syncronizeSuggestions(organizationId, repository, prNumber);

        const fineTuningType = await this.verifyFineTuningType(
            organizationId,
            repository,
            language,
        );

        if (!fineTuningType) {
            return [];
        }

        try {
            if (fineTuningType === FineTuningType.REPOSITORY) {
                suggestions =
                    (await this.getSuggestionsToRepositoryAnalysis(
                        organizationId,
                        repository,
                        language,
                    )) ?? [];
            } else {
                suggestions =
                    (await this.getSuggestionsToGlobalAnalysis(
                        organizationId,
                        language,
                    )) ?? [];
            }

            if (!suggestions?.length) {
                return [];
            }

            embeddedSuggestions.push(...suggestions);

            const mainClusterizedSuggestions =
                await this.clusterizeSuggestions(embeddedSuggestions);

            return mainClusterizedSuggestions;
        } catch (error) {
            this.logger.error({
                message: 'Error getting embedded suggestions to analyze',
                error,
                context: KodyFineTuningService.name,
                metadata: { organizationId, repository },
            });
            return [];
        }
    }

    public async fineTuningAnalysis(
        organizationId: string,
        prNumber: number,
        repository: { id: string; full_name: string; language: string },
        suggestionsToAnalyze: Partial<CodeSuggestion>[],
        mainClusterizedSuggestions: IClusterizedSuggestion[],
    ) {
        if (
            !suggestionsToAnalyze?.length ||
            !mainClusterizedSuggestions?.length
        ) {
            return {
                keepSuggestions: suggestionsToAnalyze,
                discardedSuggestions: [],
            };
        }

        const newSuggestionsToAnalyzeEmbedded =
            await this.suggestionEmbeddedService.embedSuggestionsForISuggestionToEmbed(
                suggestionsToAnalyze,
                organizationId,
                prNumber,
                repository.id,
                repository.full_name,
            );

        const { keepedSuggestions, discardedSuggestions } =
            await this.analyzeWithClusterization(
                organizationId,
                repository,
                prNumber,
                newSuggestionsToAnalyzeEmbedded,
                mainClusterizedSuggestions,
            );

        return {
            keepedSuggestions,
            discardedSuggestions,
        };
    }

    //#region Get Embedded Suggestions to make analysis
    private async getSuggestionsToGlobalAnalysis(
        organizationId: string,
        language: string,
    ): Promise<Partial<CodeSuggestion>[]> {
        return await this.suggestionEmbeddedService.find({
            language: language?.toLowerCase(),
            organization: { uuid: organizationId },
        });
    }

    private async getSuggestionsToRepositoryAnalysis(
        organizationId: string,
        repository: { id: string; full_name: string },
        language: string,
    ): Promise<Partial<CodeSuggestion>[]> {
        const embeddedSuggestions = await this.suggestionEmbeddedService.find({
            organization: { uuid: organizationId },
            repositoryId: repository.id,
            repositoryFullName: repository.full_name,
            language: language?.toLowerCase(),
        });

        return embeddedSuggestions;
    }
    //#endregion

    //#region Syncronize Suggestions (Implemeted and With User Feedback) In SQL
    async getSuggestionsWithPullRequestData(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<{
        suggestionsToEmbed: ISuggestionToEmbed[];
        pullRequests: IPullRequests[];
    }> {
        try {
            const pullRequests =
                await this.pullRequestsService.findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
                    organizationId,
                    repository,
                    status,
                    syncedEmbeddedSuggestions,
                );

            if (!pullRequests?.length) {
                return { suggestionsToEmbed: [], pullRequests: [] };
            }

            const suggestionsToEmbed = pullRequests?.reduce(
                (acc: ISuggestionToEmbed[], pr) => {
                    const prFiles = pr.files || [];

                    const prSuggestions = prFiles.reduce(
                        (fileAcc: ISuggestionToEmbed[], file) => {
                            const fileSuggestions = (
                                file.suggestions || []
                            ).map((suggestion) => ({
                                ...suggestion,
                                pullRequest: {
                                    id: pr.uuid,
                                    number: pr.number,
                                    repository: {
                                        id: pr.repository.id,
                                        fullName: pr.repository.fullName,
                                    },
                                },
                                organizationId: pr.organizationId,
                            }));
                            return [...fileAcc, ...fileSuggestions];
                        },
                        [],
                    );

                    return [...acc, ...prSuggestions];
                },
                [],
            );

            return { suggestionsToEmbed, pullRequests };
        } catch (error) {
            this.logger.log({
                message: 'Failed to get suggestions by organization and period',
                context: KodyFineTuningService.name,
                error,
                metadata: { organizationId, repository: repository, status },
            });
            throw error;
        }
    }

    async getDataForEmbedSuggestions(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        state?: PullRequestState,
    ): Promise<{
        suggestionsToEmbed: ISuggestionToEmbed[];
        pullRequests: IPullRequests[];
    }> {
        const { suggestionsToEmbed, pullRequests } =
            await this.getSuggestionsWithPullRequestData(
                organizationId,
                repository,
                state,
                false,
            );

        if (suggestionsToEmbed?.length <= 0) {
            return { suggestionsToEmbed: [], pullRequests: [] };
        }

        const suggestionsWithFeedback = await this.getSuggestionsWithFeedback(
            suggestionsToEmbed,
            organizationId,
        );

        const implementedSuggestions = await this.getImplementedSuggestions(
            suggestionsToEmbed,
            organizationId,
        );

        if (
            !implementedSuggestions?.length &&
            !suggestionsWithFeedback?.length
        ) {
            return { suggestionsToEmbed: [], pullRequests };
        }

        const refinedSuggestions =
            await this.removeDuplicateAndNeutralSuggestions(
                suggestionsWithFeedback,
                implementedSuggestions,
            );

        const suggestionsWithFeedbackFilteredLabels =
            refinedSuggestions.uniqueSuggestionsWithFeedback.filter(
                (suggestion) =>
                    suggestion.label !== 'kody_rules' &&
                    suggestion.label !== 'breaking_changes',
            );

        const implementedSuggestionsFilteredLabels =
            refinedSuggestions.uniqueImplementedSuggestions.filter(
                (suggestion) =>
                    suggestion.label !== 'kody_rules' &&
                    suggestion.label !== 'breaking_changes',
            );

        const suggestionsToNormalize = [
            ...suggestionsWithFeedbackFilteredLabels,
            ...implementedSuggestionsFilteredLabels,
        ];

        return {
            suggestionsToEmbed: suggestionsToNormalize.map((suggestion) => ({
                ...suggestion,
                suggestionContent: this.normalizeText(
                    suggestion?.suggestionContent,
                ),
                label: this.normalizeText(suggestion?.label),
                severity: this.normalizeText(suggestion?.severity),
            })),
            pullRequests,
        };
    }

    private async getImplementedSuggestions(
        allSuggestions: ISuggestionToEmbed[],
        organizationId: string,
    ): Promise<ISuggestionToEmbed[]> {
        try {
            const implementedSuggestions = allSuggestions.filter(
                (suggestion) =>
                    suggestion.implementationStatus ===
                    ImplementationStatus.IMPLEMENTED,
            );

            return implementedSuggestions;
        } catch (error) {
            this.logger.warn({
                message: 'Error getting implemented suggestions',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    allSuggestionsLength: allSuggestions?.length,
                    organizationId,
                },
            });
            return [];
        }
    }

    private async getCodeReviewFeedback(
        organizationId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<ICodeReviewFeedback[]> {
        return await this.codeReviewFeedbackService.findByOrganizationAndSyncedFlag(
            organizationId,
            syncedEmbeddedSuggestions,
        );
    }

    private async getSuggestionsWithFeedback(
        allSuggestions: ISuggestionToEmbed[],
        organizationId: string,
    ): Promise<ISuggestionToEmbed[]> {
        try {
            const feedbacks = await this.getCodeReviewFeedback(
                organizationId,
                false,
            );

            if (!feedbacks?.length || !allSuggestions?.length) {
                return [];
            }

            const feedbackMap = new Map(
                feedbacks.map((feedback) => [feedback.suggestionId, feedback]),
            );

            const suggestionsWithFeedback = allSuggestions
                .filter((suggestion) => feedbackMap.has(suggestion.id))
                .map((suggestion) => ({
                    ...suggestion,
                    feedbackType: this.identifyFeedbackType(
                        feedbackMap.get(suggestion.id),
                    ),
                }));

            return suggestionsWithFeedback;
        } catch (error) {
            this.logger.warn({
                message: 'Error getting suggestions with feedback',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    organizationId,
                    allSuggestionsLength: allSuggestions?.length,
                },
            });

            return [];
        }
    }

    private async syncronizeSuggestions(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        prNumber: number,
    ) {
        try {
            const embeddedSuggestions: ISuggestionEmbedded[] = [];

            const { suggestionsToEmbed, pullRequests } =
                await this.getDataForEmbedSuggestions(
                    organizationId,
                    repository,
                    PullRequestState.CLOSED,
                );

            if (suggestionsToEmbed?.length > 0) {
                embeddedSuggestions.push(
                    ...(await this.suggestionEmbeddedService.bulkCreateFromMongoData(
                        suggestionsToEmbed,
                    )),
                );
            }

            if (pullRequests?.length > 0) {
                let pullRequestNumbers: number[] = [
                    ...new Set(
                        pullRequests?.map((pullRequest) => pullRequest.number),
                    ),
                ];

                if (prNumber) {
                    pullRequestNumbers = pullRequestNumbers.filter(
                        (number) => number !== prNumber,
                    );
                }

                await Promise.all(
                    pullRequestNumbers?.map(async (pullRequestNumber) => {
                        await this.pullRequestsService.updateSyncedSuggestionsFlag(
                            pullRequestNumber,
                            repository.id,
                            organizationId,
                            true,
                        );
                    }),
                );
            }

            if (embeddedSuggestions?.length > 0) {
                await Promise.all(
                    embeddedSuggestions?.map(async (suggestion) => {
                        await this.codeReviewFeedbackService.updateSyncedSuggestionsFlag(
                            organizationId,
                            true,
                            suggestion?.suggestionId,
                        );
                    }),
                );

                return embeddedSuggestions;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error syncing suggestions',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    organizationId,
                    repositoryId: repository.id,
                    repositoryFullName: repository.fullName,
                },
            });
            return [];
        }
    }
    //#endregion

    //#region Helper Methods
    private normalizeText(text: string): string {
        if (!text) {
            return '';
        }
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s\-\_\.\(\)\{\}\[\]]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private identifyFeedbackType(feedback: ICodeReviewFeedback): string {
        if (!feedback?.reactions) {
            return FeedbackType.NEUTRAL;
        }

        if (
            feedback.reactions?.thumbsUp > 0 &&
            feedback.reactions?.thumbsUp > feedback.reactions?.thumbsDown
        ) {
            return FeedbackType.POSITIVE_REACTION;
        } else if (
            feedback.reactions?.thumbsDown > 0 &&
            feedback.reactions?.thumbsDown > feedback.reactions?.thumbsUp
        ) {
            return FeedbackType.NEGATIVE_REACTION;
        } else {
            return FeedbackType.NEUTRAL;
        }
    }

    private async removeDuplicateAndNeutralSuggestions(
        suggestionsWithFeedback: ISuggestionToEmbed[],
        implementedSuggestions: ISuggestionToEmbed[],
    ): Promise<{
        uniqueSuggestionsWithFeedback: ISuggestionToEmbed[];
        uniqueImplementedSuggestions: ISuggestionToEmbed[];
    }> {
        try {
            const implementedIds = new Set(
                implementedSuggestions.map((s) => s.id),
            );

            const uniqueSuggestionsWithFeedback =
                suggestionsWithFeedback.filter(
                    (suggestion) =>
                        !implementedIds.has(suggestion.id) &&
                        suggestion.feedbackType !== FeedbackType.NEUTRAL,
                );

            return {
                uniqueSuggestionsWithFeedback,
                uniqueImplementedSuggestions: implementedSuggestions.map(
                    (s) => ({
                        ...s,
                        feedbackType: FeedbackType.SUGGESTION_IMPLEMENTED,
                    }),
                ),
            };
        } catch (error) {
            this.logger.warn({
                message: 'Error removing duplicate and neutral suggestions',
                error,
                context: KodyFineTuningService.name,
            });
            return {
                uniqueSuggestionsWithFeedback: suggestionsWithFeedback,
                uniqueImplementedSuggestions: implementedSuggestions,
            };
        }
    }

    private async verifyFineTuningType(
        organizationId: string,
        repository: { id: string; full_name: string },
        language: string,
    ): Promise<FineTuningType | null> {
        const suggestionEmbedded = await this.suggestionEmbeddedService.find({
            organization: { uuid: organizationId },
            repositoryId: repository.id,
            repositoryFullName: repository.full_name,
            language: language?.toLowerCase(),
        });

        if (suggestionEmbedded?.length >= 50) {
            return FineTuningType.REPOSITORY;
        }

        const globalSuggestionEmbedded =
            await this.suggestionEmbeddedService.find({
                organization: { uuid: organizationId },
                language: language?.toLowerCase(),
            });

        if (globalSuggestionEmbedded?.length >= 50) {
            return FineTuningType.GLOBAL;
        }

        return null;
    }
    //#endregion

    //#region Clusterize Analysis
    async clusterizeSuggestions(
        suggestions: Partial<ISuggestionEmbedded>[],
    ): Promise<IClusterizedSuggestion[]> {
        try {
            if (!suggestions?.length) {
                return [];
            }

            const vectors = suggestions.map((item) => item.suggestionEmbed);

            const { max_clusters, divisor_for_cluster_quantity } =
                await this.getClustersConfig();

            const numberOfClusters = Math.min(
                max_clusters,
                Math.ceil(suggestions.length / divisor_for_cluster_quantity),
            );

            let result = kmeans(vectors, numberOfClusters, {
                initialization: 'kmeans++',
                maxIterations: 1,
            });

            const clusterizedSuggestions: IClusterizedSuggestion[] =
                suggestions.map((item, index) => {
                    const suggestion = suggestions.find(
                        (s) => s.suggestionId === item.suggestionId,
                    );
                    if (!suggestion) {
                        throw new Error(
                            `Suggestion not found for id: ${item.suggestionId}`,
                        );
                    }

                    return {
                        ...item,
                        cluster: result.clusters[index],
                        language: item.language,
                        originalSuggestion: {
                            uuid: suggestion.uuid,
                            suggestionId: suggestion.suggestionId,
                            suggestionContent: suggestion.suggestionContent,
                            suggestionEmbed: suggestion.suggestionEmbed,
                            improvedCode: suggestion.improvedCode,
                            severity: suggestion.severity as SeverityLevel,
                            label: suggestion.label,
                            feedbackType:
                                suggestion.feedbackType as FeedbackType,
                            pullRequestNumber: suggestion.pullRequestNumber,
                            repositoryId: suggestion.repositoryId,
                            repositoryFullName: suggestion.repositoryFullName,
                            organization: {
                                uuid: suggestion.organization?.uuid,
                            },
                            language: item.language,
                        },
                    };
                });

            return clusterizedSuggestions;
        } catch (error) {
            this.logger.error({
                message: 'Error in clusterizeSuggestions',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    suggestionsLength: suggestions?.length,
                    prNumber: suggestions[0]?.pullRequestNumber,
                    repositoryId: suggestions[0]?.repositoryId,
                    organizationId: suggestions[0]?.organization?.uuid,
                },
            });
            return [];
        }
    }

    private async compareSuggestionsWithClusters(
        newSuggestion: Partial<CodeSuggestion>,
        newSuggestionEmbedded: number[],
        existingClusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<{
        analyzedSuggestion: Partial<CodeSuggestion>;
        fineTuningDecision: FineTuningDecision;
    }> {
        try {
            // 1. Calculate cluster centroids
            const clusters = this.calculateClusterCentroids(
                existingClusterizedSuggestions,
            );

            // 2. Compare with centroids instead of individual suggestions
            const clusterSimilarities = Object.entries(clusters).map(
                ([clusterId, centroid]) => ({
                    clusterId: Number(clusterId),
                    similarity: this.calculateCosineSimilarity(
                        newSuggestionEmbedded,
                        centroid,
                    ),
                }),
            );

            // 3. Select the most similar cluster based on similarity strength
            const sortedClusters = clusterSimilarities.sort(
                (a, b) => b.similarity - a.similarity,
            );
            const mostSimilarCluster = sortedClusters[0]?.clusterId || 0;
            return {
                analyzedSuggestion: newSuggestion,
                fineTuningDecision: await this.analyzeClusterFeedback(
                    existingClusterizedSuggestions,
                    mostSimilarCluster,
                ),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error in compareSuggestionsWithClusters',
                error,
                context: KodyFineTuningService.name,
                metadata: {
                    newSuggestion,
                    newSuggestionEmbedded,
                    existingClusterizedSuggestions,
                },
            });
            return {
                analyzedSuggestion: newSuggestion,
                fineTuningDecision: FineTuningDecision.UNCERTAIN,
            };
        }
    }

    private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
        const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
        const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
        const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
        return dotProduct / (magnitudeA * magnitudeB);
    }

    private async analyzeClusterFeedback(
        suggestions: IClusterizedSuggestion[],
        clusterId: number,
    ): Promise<FineTuningDecision> {
        const clusterSuggestions = suggestions.filter(
            (s) => s.cluster === clusterId,
        );
        const total = clusterSuggestions.length;

        const positiveCount = clusterSuggestions.filter(
            (s) =>
                s.originalSuggestion.feedbackType ===
                    FeedbackType.POSITIVE_REACTION ||
                s.originalSuggestion.feedbackType ===
                    FeedbackType.SUGGESTION_IMPLEMENTED,
        ).length;

        const negativeCount = clusterSuggestions.filter(
            (s) =>
                s.originalSuggestion.feedbackType ===
                FeedbackType.NEGATIVE_REACTION,
        ).length;

        const positiveRatio = positiveCount / total;
        const negativeRatio = negativeCount / total;

        const { positiveThreshold, negativeThreshold } =
            await this.defineFineTuningThresholds();

        if (positiveRatio >= positiveThreshold) return FineTuningDecision.KEEP;
        if (negativeRatio >= negativeThreshold)
            return FineTuningDecision.DISCARD;
        return FineTuningDecision.UNCERTAIN;
    }

    private calculateClusterCentroids(
        suggestions: IClusterizedSuggestion[],
    ): Record<number, number[]> {
        const clusters: Record<number, number[][]> = {};

        // Group embeddings by cluster
        for (const suggestion of suggestions) {
            if (!clusters[suggestion.cluster]) {
                clusters[suggestion.cluster] = [];
            }
            clusters[suggestion.cluster].push(
                suggestion.originalSuggestion.suggestionEmbed,
            );
        }

        // Calculate centroid for each cluster
        const centroids: Record<number, number[]> = {};
        for (const [clusterId, embeddings] of Object.entries(clusters)) {
            const dimensions = embeddings[0].length;
            const centroid = new Array(dimensions).fill(0);

            for (const embedding of embeddings) {
                for (let i = 0; i < dimensions; i++) {
                    centroid[i] += embedding[i];
                }
            }

            // Normalize
            for (let i = 0; i < dimensions; i++) {
                centroid[i] /= embeddings.length;
            }

            centroids[Number(clusterId)] = centroid;
        }

        return centroids;
    }

    private async defineWhichClusterShouldBeUsed(
        organizationId: string,
        mainClusterizedSuggestions: IClusterizedSuggestion[],
        newSuggestion: Partial<CodeSuggestion>,
        repository: { id: string; full_name: string; language: string },
        prNumber: number,
    ): Promise<IClusterizedSuggestion[]> {
        if (
            newSuggestion?.language?.toLowerCase() ==
            mainClusterizedSuggestions[0]?.language?.toLowerCase()
        ) {
            return mainClusterizedSuggestions;
        }

        const clusterizedSuggestionsPerFileLanguage = await this.startAnalysis(
            organizationId,
            repository,
            prNumber,
            newSuggestion?.language?.toLowerCase(),
        );

        return clusterizedSuggestionsPerFileLanguage;
    }

    private async analyzeWithClusterization(
        organizationId: string,
        repository: { id: string; full_name: string; language: string },
        prNumber: number,
        suggestionsToAnalyze: Partial<CodeSuggestion>[],
        mainClusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<{
        keepedSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestions: Partial<CodeSuggestion>[];
    }> {
        if (!mainClusterizedSuggestions?.length) {
            return {
                keepedSuggestions: suggestionsToAnalyze,
                discardedSuggestions: [],
            };
        }

        const results = [];

        for (const newSuggestion of suggestionsToAnalyze) {
            const newEmbedding =
                await this.suggestionEmbeddedService.embedSuggestionsForISuggestionToEmbed(
                    [newSuggestion],
                    organizationId,
                    prNumber,
                    repository.id,
                    repository.full_name,
                );

            const clusterizedSuggestions =
                await this.defineWhichClusterShouldBeUsed(
                    organizationId,
                    mainClusterizedSuggestions,
                    newSuggestion,
                    repository,
                    prNumber,
                );

            if (
                !clusterizedSuggestions?.length ||
                clusterizedSuggestions?.length < 50
            ) {
                continue;
            }

            const comparison = await this.compareSuggestionsWithClusters(
                newSuggestion,
                newEmbedding[0].suggestionEmbed,
                clusterizedSuggestions,
            );
            results.push(comparison);
        }

        const keepSuggestions = results.filter(
            (suggestion) =>
                suggestion.fineTuningDecision === FineTuningDecision.KEEP ||
                suggestion.fineTuningDecision === FineTuningDecision.UNCERTAIN,
        );

        const discardedSuggestions = results.filter(
            (suggestion) =>
                suggestion.fineTuningDecision === FineTuningDecision.DISCARD,
        );

        return {
            keepedSuggestions: keepSuggestions.map(
                (suggestion) => suggestion.analyzedSuggestion,
            ),
            discardedSuggestions: discardedSuggestions.map(
                (suggestion) => suggestion.analyzedSuggestion,
            ),
        };
    }
    //#endregion

    private async defineFineTuningThresholds(): Promise<{
        positiveThreshold: number;
        negativeThreshold: number;
    }> {
        const globalParameters = await this.globalParametersService.findByKey(
            GlobalParametersKey.KODY_FINE_TUNING_CONFIG,
        );

        return {
            positiveThreshold:
                globalParameters?.configValue?.positiveThreshold ??
                this.SIMILARITY_THRESHOLD_POSITIVE,
            negativeThreshold:
                globalParameters?.configValue?.negativeThreshold ??
                this.SIMILARITY_THRESHOLD_NEGATIVE,
        };
    }

    private async getClustersConfig(): Promise<{
        max_clusters: number;
        divisor_for_cluster_quantity: number;
    }> {
        const globalParameters = await this.globalParametersService.findByKey(
            GlobalParametersKey.KODY_FINE_TUNING_CONFIG,
        );

        return {
            max_clusters:
                globalParameters?.configValue?.maxClusters ?? this.MAX_CLUSTERS,
            divisor_for_cluster_quantity:
                globalParameters?.configValue?.divisorForClusterQuantity ??
                this.DIVISOR_FOR_CLUSTER_QUANTITY,
        };
    }
}
