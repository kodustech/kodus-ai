import { Injectable } from '@nestjs/common';
import { ICommentManagerService } from '../../../../domain/codeBase/contracts/CommentManagerService.contract';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { PinoLoggerService } from '../logger/pino.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    Comment,
    FileChange,
    SummaryConfig,
    BehaviourForExistingDescription,
    CodeReviewConfig,
    CommentResult,
    CodeSuggestion,
    ClusteringType,
} from '@/config/types/general/codeReview.type';

import {
    getChatGPT,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { prompt_repeated_suggestion_clustering_system } from '@/shared/utils/langchainCommon/prompts/repeatedCodeReviewSuggestionClustering';
import { LLMResponseProcessor } from './utils/transforms/llmResponseProcessor.transform';

interface ClusteredSuggestion {
    id: string;
    sameSuggestionsId?: string[];
    problemDescription?: string;
    actionStatement?: string;
}
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

@Injectable()
export class CommentManagerService implements ICommentManagerService {
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {
        this.llmResponseProcessor = new LLMResponseProcessor(logger);
    }

    async generateSummaryPR(
        pullRequest: any,
        repository: { name: string; id: string },
        comments: any[],
        organizationAndTeamData: OrganizationAndTeamData,
        languageResultPrompt: string,
        summaryConfig: SummaryConfig,
    ) {
        if (!summaryConfig?.generatePRSummary) {
            return null;
        }

        const maxRetries = 2;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                // Fetch the updated PR to get the latest description
                const updatedPR =
                    await this.codeManagementService.getPullRequestByNumber({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    });

                let llm = getChatGPT({
                    model: getLLMModelProviderWithFallback(
                        LLMModelProvider.CHATGPT_4_ALL,
                    ),
                });

                // Building the base prompt
                let promptBase = `Based on the file change summaries provided below, generate a precise description for this pull request.
The description should strictly reflect the information provided in the summaries and the pull request metadata.
Avoid making assumptions or including inferred details not present in the provided data.`;

                // Adds the existing description only for COMPLEMENT mode
                if (
                    updatedPR?.body &&
                    summaryConfig?.behaviourForExistingDescription ===
                    BehaviourForExistingDescription.COMPLEMENT
                ) {
                    promptBase += `\n\n**Additional Instructions**:
                    - Focus on generating new insights and relevant information
                    - Highlight changes that are not covered in the existing description
                    - Provide technical context that complements the current description

                    **Existing Description**:
                    ${updatedPR.body}`;
                }

                // Adds custom instructions if provided
                if (summaryConfig?.customInstructions) {
                    promptBase += `\n\n**Custom Instructions**:\n${summaryConfig.customInstructions}`;
                }

                promptBase += `\n\n**Important**:
                    - Use only the data provided below. Do not add inferred information or assumptions.
                    - Write the description in ${languageResultPrompt}.

                    **Pull Request Details**:
                    - **Repository**: ${pullRequest?.head?.repo?.fullName || 'Desconhecido'}
                    - **Source Branch**: \`${pullRequest?.head?.ref}\`
                    - **Target Branch**: \`${pullRequest?.base?.ref}\`
                    - **Title**: ${pullRequest?.title || 'Sem título'}

                    **File Change Summaries**:
                    ${comments
                        .map(
                            (comment) =>
                                `- **File**: ${comment?.filepath} (${comment?.status})\n  **Summary**: ${comment?.summary}`,
                        )
                        .join('\n\n')}`;

                const chain = await llm.invoke(promptBase, {
                    metadata: {
                        module: 'CodeBase',
                        submodule: 'CommentManagerService',
                        ...organizationAndTeamData,
                    },
                });

                let finalDescription = chain.content || 'No comment generated';

                // Apply CONCATENATE behavior if necessary
                if (
                    updatedPR?.body &&
                    summaryConfig?.behaviourForExistingDescription ===
                    BehaviourForExistingDescription.CONCATENATE
                ) {
                    finalDescription = `${updatedPR.body}\n\n---\n\n${finalDescription}`;
                }

                return finalDescription;
            } catch (error) {
                this.logger.error({
                    message: `Error generateOverallComment pull request: PR#${pullRequest?.number}`,
                    context: CommentManagerService.name,
                    error: error,
                    metadata: {
                        organizationAndTeamData,
                        pullRequest,
                    },
                });
                retryCount++;

                if (retryCount === maxRetries) {
                    throw new Error(
                        'Error generateOverallComment pull request. Max retries exceeded',
                    );
                }
            }
        }
    }

    async updateSummarizationInPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        summary: string,
    ): Promise<void> {
        try {
            await this.codeManagementService.updateDescriptionInPullRequest({
                organizationAndTeamData,
                prNumber,
                repository: {
                    name: repository.name,
                    id: repository.id,
                },
                summary,
            });

            this.logger.log({
                message: `Updated summary for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: { prNumber, summary },
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to update overall comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                },
            });
            throw error;
        }
    }

    generateSummaryMarkdown(
        changedFiles: FileChange[],
        description: string,
    ): string {
        throw new Error('Method not implemented.');
    }

    async createInitialComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        changedFiles: FileChange[],
        language: string,
        platformType: PlatformType,
    ): Promise<{ commentId: number; noteId: number; threadId?: number }> {
        try {
            let commentBody = await this.generatePullRequestSummaryMarkdown(
                changedFiles,
                language,
                platformType,
            );

            commentBody = this.sanitizeBitbucketMarkdown(
                commentBody,
                platformType,
            );

            const comment = await this.codeManagementService.createIssueComment(
                {
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository.name,
                        id: repository.id,
                    },
                    body: commentBody,
                },
            );

            const commentId = Number(comment?.id) || null;

            let noteId = null;
            let threadId = null;

            // Extract platform-specific IDs
            switch (platformType) {
                case PlatformType.GITLAB:
                    // GitLab uses noteId
                    noteId = comment?.notes?.[0]?.id ? Number(comment.notes[0].id) : null;
                    break;
                case PlatformType.AZURE_REPOS:
                    // Azure Repos uses threadId
                    threadId = comment?.threadId ? Number(comment.threadId) : null;
                    break;
                default:
                    break;
            }

            this.logger.log({
                message: `Created initial comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: { commentId, noteId, threadId },
            });

            return { commentId, noteId, threadId };
        } catch (error) {
            this.logger.error({
                message: `Failed to create initial comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    changedFiles,
                    language,
                    platformType,
                },
            });
            throw error;
        }
    }

    async updateOverallComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        commentId: number,
        noteId: number,
        platformType: PlatformType,
        codeSuggestions?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        threadId?: number,
    ): Promise<void> {
        try {
            let commentBody =
                await this.generatePullRequestFinishSummaryMarkdown(
                    organizationAndTeamData,
                    prNumber,
                    codeSuggestions,
                    codeReviewConfig,
                );

            commentBody = this.sanitizeBitbucketMarkdown(
                commentBody,
                platformType,
            );

            await this.codeManagementService.updateIssueComment({
                organizationAndTeamData,
                prNumber,
                commentId,
                repository: {
                    name: repository.name,
                    id: repository.id,
                },
                body: commentBody,
                noteId,
                threadId,
            });

            this.logger.log({
                message: `Updated overall comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: { commentId, noteId, threadId },
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to update overall comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    commentId,
                    noteId,
                    threadId,
                    platformType,
                },
            });
            throw error;
        }
    }

    async createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        lineComments: Comment[],
        language: string,
    ): Promise<{
        lastAnalyzedCommit: any;
        commits: any[];
        commentResults: Array<CommentResult>;
    }> {
        try {
            const commits =
                await this.codeManagementService.getCommitsForPullRequestForCodeReview(
                    {
                        organizationAndTeamData,
                        repository,
                        prNumber,
                    },
                );

            if (!commits?.length) {
                return {
                    lastAnalyzedCommit: null,
                    commits: [],
                    commentResults: [],
                };
            }

            const lastAnalyzedCommit = commits[commits.length - 1];
            const commentResults = [];

            if (!lineComments?.length) {
                this.logger.log({
                    message: `Not Create Line Comments PR#${prNumber}, because not lineComments`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repository,
                        lineComments,
                    },
                });
                return {
                    lastAnalyzedCommit,
                    commits,
                    commentResults,
                };
            }

            this.logger.log({
                message: `Create Line Comments PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    lineComments,
                },
            });

            for (const comment of lineComments) {
                try {
                    const createdComment =
                        await this.codeManagementService.createReviewComment({
                            organizationAndTeamData,
                            repository,
                            commit: lastAnalyzedCommit,
                            prNumber,
                            lineComment: comment,
                            language,
                        });
                    commentResults.push({
                        comment,
                        deliveryStatus: 'sent',
                        codeReviewFeedbackData: {
                            commentId: createdComment?.id,
                            pullRequestReviewId:
                                createdComment?.pull_request_review_id,
                            suggestionId: comment.suggestion.id,
                        },
                    });
                } catch (error) {
                    commentResults.push({
                        comment,
                        deliveryStatus: error.errorType || 'failed',
                    });
                }
            }

            return { lastAnalyzedCommit, commits, commentResults };
        } catch (error) {
            this.logger.error({
                message: `Failed to create line comments for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    lineComments,
                },
            });
            throw error;
        }
    }

    private generatePullRequestFinishSummaryMarkdown(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        commentResults?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
    ): string {
        try {
            const language =
                codeReviewConfig?.languageResultPrompt ?? LanguageValue.ENGLISH;
            const translation = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.PullRequestFinishSummaryMarkdown,
            );

            if (!translation) {
                throw new Error(
                    `No translation found for language: ${language}`,
                );
            }

            const hasComments = !!commentResults?.length;
            const resultText = hasComments
                ? translation.withComments
                : translation.withoutComments;

            if (!resultText) {
                throw new Error(
                    `No result text found for language: ${language}`,
                );
            }

            return `${resultText}\n\n${this.generateConfigReviewMarkdown(organizationAndTeamData, prNumber, codeReviewConfig)}\n\n<!-- kody-codereview -->\n&#8203;`;
        } catch (error) {
            this.logger.error({
                message:
                    'Error generating pull request finish summary markdown',
                context: CommentManagerService.name,
                error: error.message,
                metadata: { commentResults, organizationAndTeamData, prNumber },
            });

            const fallbackText = '## Code Review Completed! 🔥';

            return `${fallbackText}\n\n<!-- kody-codereview -->\n&#8203;`;
        }
    }

    /**
     * Generates the Pull Request summary markdown based on the changed files.
     */
    private generatePullRequestSummaryMarkdown(
        changedFiles: FileChange[],
        language: string,
        platformType: PlatformType,
    ): string {
        try {
            const translation = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.PullRequestSummaryMarkdown,
            );

            if (!translation) {
                throw new Error(
                    `No translation found for the given language: ${language}`,
                );
            }

            const filesTable = changedFiles
                ?.map(
                    (file) =>
                        `| [${file.filename}](${file.blob_url}) | ${file.status} | ${file.additions} | ${file.deletions} | ${file.changes} |`,
                )
                .join('\n');

            const totalFilesModified = changedFiles.length;
            const totalAdditions = changedFiles.reduce(
                (acc, file) => acc + file.additions,
                0,
            );
            const totalDeletions = changedFiles.reduce(
                (acc, file) => acc + file.deletions,
                0,
            );
            const totalChanges = changedFiles.reduce(
                (acc, file) => acc + file.changes,
                0,
            );

            //Do not touch this formatting, there cannot be spaces
            return `
# ${translation.title}

## ${translation.codeReviewStarted}

${translation.description}

<details>
<summary>${translation.changedFiles}</summary>

| ${translation.filesTable.join(' | ')} |
|------|--------|-------------|-------------|------------|
${filesTable}
</details>

<details>
<summary>${translation.summary}</summary>

- **${translation.totalFiles}**: ${totalFilesModified}
- **${translation.totalAdditions}**: ${totalAdditions}
- **${translation.totalDeletions}**: ${totalDeletions}
- **${translation.totalChanges}**: ${totalChanges}
</details>

<!-- kody-codereview -->\n&#8203;`.trim();
        } catch (error) {
            this.logger.error({
                message: 'Error generating pull request summary markdown',
                context: CommentManagerService.name,
                error: error.message,
                metadata: { changedFiles, language },
            });

            return ''; // Returns an empty string to ensure something is sent
        }
    }

    private generateConfigReviewMarkdown(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeReviewConfig: CodeReviewConfig,
    ): string {
        try {
            const language =
                codeReviewConfig?.languageResultPrompt ?? LanguageValue.ENGLISH;
            const translation = getTranslationsForLanguageByCategory(
                language as LanguageValue,
                TranslationsCategory.ConfigReviewMarkdown,
            );

            if (!translation) {
                throw new Error(
                    `Translation not found for the given language: ${language}`,
                );
            }

            // Generate review options
            const reviewOptionsMarkdown = Object.entries(
                codeReviewConfig.reviewOptions,
            )
                .map(
                    ([key, value]) =>
                        `| **${key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())}** | ${value ? translation.enabled : translation.disabled
                        } |`,
                )
                .join('\n');

            return `
<details>
<summary>${translation.title}</summary>

<details>
<summary>${translation.interactingTitle}</summary>

- **${translation.requestReview}:** ${translation.requestReviewDesc}

- **${translation.provideFeedback}:** ${translation.provideFeedbackDesc}

</details>

<details>
<summary>${translation.configurationTitle}</summary>

<details>
<summary>${translation.reviewOptionsTitle}</summary>

${translation.reviewOptionsDesc}

| ${translation.tableOptions}                        | ${translation.tableEnabled} |
|-------------------------------|---------|
${reviewOptionsMarkdown}

</details>

**[${translation.configurationLink}](https://app.kodus.io/settings/code-review/global/general)**

</details>
</details>
    `.trim();
        } catch (error) {
            this.logger.error({
                message: 'Error generating config review markdown',
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                },
            });
            return ''; // Returns an empty string to ensure something is sent
        }
    }

    //#region Repeated Code Review Suggestion Clustering
    async repeatedCodeReviewSuggestionClustering(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: any[],
    ) {
        const baseContext = {
            organizationAndTeamData,
            prNumber,
            codeSuggestions,
        };

        const chain =
            await this.createRepeatedCodeReviewSuggestionClusteringChainWithFallback(
                organizationAndTeamData,
                prNumber,
                provider,
                baseContext,
            );

        let repeteadSuggetionsClustered;

        try {
            const result = await chain.invoke(baseContext);
            repeteadSuggetionsClustered =
                this.llmResponseProcessor.processResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );
        } catch (error) {
            this.logger.error({
                message:
                    'Error executing repeated code review suggestion clustering chain:',
                error,
                context: CommentManagerService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
        }

        if (
            !repeteadSuggetionsClustered.codeSuggestions ||
            repeteadSuggetionsClustered.codeSuggestions.length === 0
        ) {
            return codeSuggestions;
        } else {
            return await this.processSuggestions(
                codeSuggestions,
                repeteadSuggetionsClustered,
            );
        }
    }

    private async createRepeatedCodeReviewSuggestionClusteringChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.CHATGPT_4_ALL;

        try {
            // Main chain
            const mainChain =
                await this.createRepeatedCodeReviewSuggestionClusteringChain(
                    organizationAndTeamData,
                    prNumber,
                    provider,
                    context,
                );

            // Fallback chain
            const fallbackChain =
                await this.createRepeatedCodeReviewSuggestionClusteringChain(
                    organizationAndTeamData,
                    prNumber,
                    fallbackProvider,
                    context,
                );

            // Configure chain with fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'repeatedCodeReviewSuggestionClustering',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider,
                        fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating clustering chain with fallback',
                error,
                context: CommentManagerService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
            throw error;
        }
    }

    private async createRepeatedCodeReviewSuggestionClusteringChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                        temperature: 0,
                        maxTokens: 8000,
                    })
                    : getChatGPT({
                        model: getLLMModelProviderWithFallback(
                            LLMModelProvider.CHATGPT_4_ALL_MINI,
                        ),
                        temperature: 0,
                    });

            if (provider === LLMModelProvider.CHATGPT_4_ALL_MINI) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const systemPrompt =
                        prompt_repeated_suggestion_clustering_system();

                    return [
                        {
                            role: 'system',
                            content: [
                                {
                                    type: 'text',
                                    text: systemPrompt,
                                },
                            ],
                        },
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: `<codeSuggestionsContext>${JSON.stringify(input?.codeSuggestions, null, 2) || 'No code suggestions provided'}</codeSuggestionsContext>`,
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating repeated code review suggestion clustering chain for PR#${prNumber}`,
                error,
                context: CommentManagerService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                    provider,
                },
            });
        }
    }

    private async enrichSuggestions(
        originalSuggestions: any[],
        clusteredSuggestions: ClusteredSuggestion[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const clusteredIds =
            await this.extractAllClusteredIds(clusteredSuggestions);

        const nonClusteredSuggestions =
            await this.filterNonClusteredSuggestions(
                originalSuggestions,
                clusteredIds,
            );

        const enrichedClusteredSuggestions =
            await this.enrichClusteredSuggestions(
                originalSuggestions,
                clusteredSuggestions,
            );

        // Filters duplicate suggestions
        const suggestions = [
            ...nonClusteredSuggestions,
            ...enrichedClusteredSuggestions,
        ];

        return suggestions;
    }

    private async extractAllClusteredIds(
        clusteredSuggestions: ClusteredSuggestion[],
    ): Promise<Set<string>> {
        const allIds = new Set<string>();

        await Promise.all(
            clusteredSuggestions.map(async (suggestion) => {
                allIds.add(suggestion.id);
                await Promise.all(
                    suggestion.sameSuggestionsId.map(async (id) =>
                        allIds.add(id),
                    ),
                );
            }),
        );

        return allIds;
    }

    private async filterNonClusteredSuggestions(
        originalSuggestions: any[],
        clusteredIds: Set<string>,
    ): Promise<Partial<CodeSuggestion>[]> {
        return originalSuggestions
            .filter((suggestion) => !clusteredIds.has(suggestion.id))
            .map((suggestion) => ({ ...suggestion }));
    }

    private async enrichClusteredSuggestions(
        originalSuggestions: any[],
        clusteredSuggestions: ClusteredSuggestion[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const enrichedSuggestions: Partial<CodeSuggestion>[] = [];

        await Promise.all(
            clusteredSuggestions.map(async (cluster) => {
                const parentSuggestion =
                    await this.findAndEnrichParentSuggestion(
                        originalSuggestions,
                        cluster,
                    );
                enrichedSuggestions.push(parentSuggestion);

                const relatedSuggestions =
                    await this.findAndEnrichRelatedSuggestions(
                        originalSuggestions,
                        cluster,
                    );
                enrichedSuggestions.push(...relatedSuggestions);
            }),
        );

        return enrichedSuggestions;
    }

    private findAndEnrichParentSuggestion(
        originalSuggestions: any[],
        cluster: ClusteredSuggestion,
    ): Partial<CodeSuggestion> {
        const originalSuggestion = originalSuggestions.find(
            (s) => s.id === cluster.id,
        );

        return {
            ...originalSuggestion,
            clusteringInformation: {
                type: ClusteringType.PARENT,
                relatedSuggestionsIds: cluster.sameSuggestionsId,
                problemDescription: cluster.problemDescription,
                actionStatement: cluster.actionStatement,
            },
        };
    }

    private findAndEnrichRelatedSuggestions(
        originalSuggestions: any[],
        cluster: ClusteredSuggestion,
    ): Partial<CodeSuggestion>[] {
        return cluster.sameSuggestionsId.map((id) => {
            const originalSuggestion = originalSuggestions.find(
                (s) => s.id === id,
            );

            return {
                ...originalSuggestion,
                clusteringInformation: {
                    type: ClusteringType.RELATED,
                    parentSuggestionId: cluster.id,
                },
            };
        });
    }

    // Usage in your service:
    private async processSuggestions(
        codeSuggestions: any[],
        repeatedSuggestionsClustered: {
            codeSuggestions: ClusteredSuggestion[];
        },
    ) {
        return this.enrichSuggestions(
            codeSuggestions,
            repeatedSuggestionsClustered.codeSuggestions,
        );
    }
    //#endregion

    async enrichParentSuggestionsWithRelated(
        suggestions: CodeSuggestion[],
    ): Promise<CodeSuggestion[]> {
        return suggestions.map((suggestion) => {
            if (
                suggestion.clusteringInformation?.type !== ClusteringType.PARENT
            ) {
                return suggestion;
            }

            const relatedSuggestions = suggestions.filter(
                (s) =>
                    s.clusteringInformation?.type === ClusteringType.RELATED &&
                    s.clusteringInformation?.parentSuggestionId ===
                    suggestion.id,
            );

            const occurrences = [
                {
                    file: suggestion.relevantFile,
                    lines: `${suggestion.relevantLinesStart}-${suggestion.relevantLinesEnd}`,
                },
                ...relatedSuggestions.map((s) => ({
                    file: s.relevantFile,
                    lines: `${s.relevantLinesStart}-${s.relevantLinesEnd}`,
                })),
            ];

            const enrichedBody = `${suggestion?.clusteringInformation?.problemDescription}\n\nThis issue appears in multiple locations:\n${occurrences
                .map((o) => `* ${o.file}: Lines ${o.lines}`)
                .join('\n')}`;

            return {
                ...suggestion,
                suggestionContent: enrichedBody,
            };
        });
    }

    private sanitizeBitbucketMarkdown(
        markdown: string,
        platformType: PlatformType,
    ): string {
        return platformType === PlatformType.BITBUCKET
            ? markdown
                .replace(
                    /(<\/?details>)|(<\/?summary>)|(<!-- kody-codereview -->(\n|\\n)?&#8203;)/g,
                    '',
                )
                .trim()
            : markdown;
    }
}
