import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { buildCommentFromSuggestion } from '@libs/common/utils/comment-builder.utils';
import {
    BehaviourForExistingDescription,
    BehaviourForNewCommits,
    ClusteringType,
    CodeReviewConfig,
    CodeSuggestion,
    Comment,
    CommentResult,
    FallbackSuggestionsBySeverity,
    FileChange,
    SummaryConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ICommentManagerService } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { LLMResponseProcessor } from '@libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform';
import {
    MessageTemplateProcessor,
    PlaceholderContext,
} from './messageTemplateProcessor.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@libs/common/utils/translations/translations';
import { prompt_repeated_suggestion_clustering_system } from '@libs/common/utils/langchainCommon/prompts/repeatedCodeReviewSuggestionClustering';
import { createLogger } from '@kodus/flow';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { estimateTokens, tokensToChars } from './utils/token-estimator';

interface ClusteredSuggestion {
    id: string;
    sameSuggestionsId?: string[];
    problemDescription?: string;
    actionStatement?: string;
}

@Injectable()
export class CommentManagerService implements ICommentManagerService {
    private readonly llmResponseProcessor: LLMResponseProcessor;
    private readonly logger = createLogger(CommentManagerService.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly messageProcessor: MessageTemplateProcessor,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly codeManagementService: CodeManagementService,
    ) {
        this.llmResponseProcessor = new LLMResponseProcessor();
    }

    async generateSummaryPR(
        pullRequest: any,
        repository: { name: string; id: string },
        changedFiles: Partial<FileChange>[],
        organizationAndTeamData: OrganizationAndTeamData,
        languageResultPrompt: string,
        summaryConfig: SummaryConfig,
        byokConfig?: BYOKConfig,
        isCommitRun?: boolean,
        prPreview?: boolean,
        externalPromptContext?: any,
    ): Promise<string> {
        let byokConfigValue: BYOKConfig | null = byokConfig ?? null;

        if (!summaryConfig?.generatePRSummary) {
            return null;
        }

        if (prPreview) {
            const validationResult =
                await this.permissionValidationService.validateBasicLicense(
                    organizationAndTeamData,
                    CommentManagerService.name,
                );
            if (!validationResult.allowed) {
                return null;
            }

            byokConfigValue =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );
        }

        const maxRetries = 2;
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                const updatedPR =
                    await this.codeManagementService.getPullRequestByNumber({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    });

                this.logger.log({
                    message: `GenerateSummaryPR: Start PR#${pullRequest?.number}. After get PR data`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        pullRequestNumber: pullRequest?.number,
                        repositoryId: repository?.id,
                        summaryConfig,
                        prDescription: updatedPR?.body,
                    },
                });
                let promptBase = `Based on the code changes (patches) provided below, generate a precise description for this pull request.
    Analyze the actual code modifications to understand what was implemented, fixed, or changed.
    Focus on the functional impact and purpose of the changes rather than technical implementation details.
    Avoid making assumptions beyond what can be inferred from the code changes.`;

                if (
                    !isCommitRun &&
                    updatedPR?.body &&
                    summaryConfig?.behaviourForExistingDescription ===
                        BehaviourForExistingDescription.COMPLEMENT
                ) {
                    promptBase += `\n\n**Additional Instructions**:
                    - Focus on generating new insights and relevant information based on the code changes
                    - Highlight modifications that are not covered in the existing description
                    - Provide technical context that complements the current description

                    **Existing Description**:
                    ${updatedPR.body}`;
                }

                // Adds custom instructions if provided
                if (summaryConfig?.customInstructions) {
                    let customInstructionsText =
                        summaryConfig.customInstructions;

                    // Inject external context if available
                    if (
                        externalPromptContext?.customInstructions?.references
                            ?.length > 0
                    ) {
                        const contextSection =
                            externalPromptContext.customInstructions.references
                                .map((ref) => {
                                    const header = ref.lineRange
                                        ? `\n--- Content from ${ref.filePath} (lines ${ref.lineRange.start}-${ref.lineRange.end}) ---\n`
                                        : `\n--- Content from ${ref.filePath} ---\n`;
                                    return `${header}${ref.content}\n--- End of ${ref.filePath} ---`;
                                })
                                .join('\n');

                        customInstructionsText += `\n\n## External Reference Context\n${contextSection}`;
                    }

                    promptBase += `\n\n**Custom Instructions**:\n${customInstructionsText}`;
                }

                promptBase += `\n\n**Important**:
                    - Analyze the code changes to understand the functional purpose and impact
                    - Focus on WHAT was changed and WHY (based on the code context)
                    - Summarize the changes in business/functional terms when possible
                    - Use only the code changes provided. Do not add inferred information beyond what the code clearly shows.
                    - You must always respond in ${languageResultPrompt}.

                    **Pull Request Details**:
                    - **Repository**: ${pullRequest?.head?.repo?.fullName || 'Unknown'}
                    - **Source Branch**: \`${pullRequest?.head?.ref}\`
                    - **Target Branch**: \`${pullRequest?.base?.ref}\`
                    - **Title**: ${pullRequest?.title || 'Untitled'}`;

                const baseContext = {
                    changedFiles,
                    pullRequest,
                    repository,
                    summaryConfig,
                    languageResultPrompt,
                    updatedPR,
                };

                let userPromptPrefix = '';

                if (
                    isCommitRun &&
                    summaryConfig?.behaviourForNewCommits ===
                        BehaviourForNewCommits.REPLACE
                ) {
                    const existingBodyForPrompt = updatedPR?.body || '';
                    const summaryBlockRegex =
                        /<!-- kody-pr-summary:start -->([\s\S]*?)<!-- kody-pr-summary:end -->/;
                    const previousMatch =
                        existingBodyForPrompt.match(summaryBlockRegex);
                    const previousSummary = previousMatch
                        ? previousMatch[1].trim()
                        : '';

                    if (previousSummary) {
                        userPromptPrefix = `
                    This is the previous pull request summary (generated before the latest commits):
                    <previousPullRequestSummary>${previousSummary}</previousPullRequestSummary>
                    Generate a new, complete and updated summary that incorporates both the previous context and the new code changes. Do not include HTML comments or markers in your output.`;
                    }
                }

                const fallbackProvider = LLMModelProvider.OPENAI_GPT_4O;

                const promptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    LLMModelProvider.GEMINI_2_5_FLASH,
                    fallbackProvider,
                    byokConfigValue,
                );

                const runName = 'generateSummaryPR';
                const spanName = `${CommentManagerService.name}::${runName}`;
                const spanAttrs = {
                    type: promptRunner.executeMode,
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber: pullRequest?.number,
                    repositoryId: repository?.id,
                };

                const llmMetadata = {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                    pullRequestId: pullRequest?.number,
                    repositoryId: repository?.id,
                    provider:
                        byokConfigValue?.main?.provider ||
                        LLMModelProvider.GEMINI_2_5_FLASH,
                    fallbackProvider:
                        byokConfigValue?.fallback?.provider || fallbackProvider,
                    model: byokConfigValue?.main?.model,
                    fallbackModel: byokConfigValue?.fallback?.model,
                    runName,
                };

                // --- Chunk changedFiles if maxInputTokens is configured ---
                const maxInputTokens = byokConfigValue?.main?.maxInputTokens;

                const fileChunks = this.chunkChangedFilesForSummary(
                    changedFiles,
                    promptBase,
                    userPromptPrefix,
                    maxInputTokens,
                );

                // More than 4 chunks → skip summary generation
                if (!fileChunks) {
                    this.logger.warn({
                        message: `Skipping PR summary generation: changedFiles exceed max 4 chunks for PR#${pullRequest?.number}`,
                        context: CommentManagerService.name,
                        metadata: {
                            organizationAndTeamData,
                            pullRequestNumber: pullRequest?.number,
                            maxInputTokens,
                        },
                    });
                    return null;
                }

                let result: string;

                if (fileChunks.length === 1) {
                    // Single chunk — normal path (no chunking needed)
                    const userPrompt =
                        userPromptPrefix +
                        `<changedFilesContext>${JSON.stringify(fileChunks[0]) || 'No files changed'}</changedFilesContext>`;

                    const llmResult =
                        await this.observabilityService.runLLMInSpan<string>({
                            spanName,
                            runName,
                            attrs: spanAttrs,
                            exec: async (callbacks) => {
                                return await promptRunner
                                    .builder()
                                    .setParser(ParserType.STRING)
                                    .setLLMJsonMode(false)
                                    .setPayload(baseContext)
                                    .addPrompt({
                                        prompt: promptBase,
                                        role: PromptRole.SYSTEM,
                                    })
                                    .addPrompt({
                                        prompt: userPrompt,
                                        role: PromptRole.USER,
                                    })
                                    .addMetadata(llmMetadata)
                                    .addCallbacks(callbacks)
                                    .setRunName(runName)
                                    .setTemperature(0)
                                    .execute();
                            },
                        });

                    result = llmResult.result;
                } else {
                    // Multiple chunks (2–4) — generate partial summaries then consolidate
                    this.logger.log({
                        message: `Generating PR summary in ${fileChunks.length} chunks for PR#${pullRequest?.number}`,
                        context: CommentManagerService.name,
                        metadata: {
                            organizationAndTeamData,
                            pullRequestNumber: pullRequest?.number,
                            totalChunks: fileChunks.length,
                            maxInputTokens,
                        },
                    });

                    const partialSummaries: string[] = [];

                    for (let i = 0; i < fileChunks.length; i++) {
                        const chunkUserPrompt =
                            userPromptPrefix +
                            `<changedFilesContext>${JSON.stringify(fileChunks[i])}</changedFilesContext>`;

                        const chunkRunName = `${runName}_chunk_${i + 1}`;
                        const chunkSpanName = `${CommentManagerService.name}::${chunkRunName}`;

                        const chunkResult =
                            await this.observabilityService.runLLMInSpan<string>(
                                {
                                    spanName: chunkSpanName,
                                    runName: chunkRunName,
                                    attrs: {
                                        ...spanAttrs,
                                        chunkIndex: i,
                                        totalChunks: fileChunks.length,
                                    },
                                    exec: async (callbacks) => {
                                        return await promptRunner
                                            .builder()
                                            .setParser(ParserType.STRING)
                                            .setLLMJsonMode(false)
                                            .setPayload(baseContext)
                                            .addPrompt({
                                                prompt:
                                                    promptBase +
                                                    `\n\n**Note**: This is chunk ${i + 1} of ${fileChunks.length}. Generate a summary for these files only.`,
                                                role: PromptRole.SYSTEM,
                                            })
                                            .addPrompt({
                                                prompt: chunkUserPrompt,
                                                role: PromptRole.USER,
                                            })
                                            .addMetadata({
                                                ...llmMetadata,
                                                runName: chunkRunName,
                                            })
                                            .addCallbacks(callbacks)
                                            .setRunName(chunkRunName)
                                            .setTemperature(0)
                                            .execute();
                                    },
                                },
                            );

                        if (chunkResult.result) {
                            partialSummaries.push(chunkResult.result);
                        }
                    }

                    if (partialSummaries.length === 0) {
                        this.logger.error({
                            message: `All chunks returned empty for generateSummaryPR: PR#${pullRequest?.number}`,
                            context: CommentManagerService.name,
                            metadata: { organizationAndTeamData, pullRequest },
                        });
                        throw new Error(
                            'No result returned from generateSummaryPR',
                        );
                    }

                    // Consolidation call: merge partial summaries into one
                    const consolidationRunName = `${runName}_consolidation`;
                    const consolidationSpanName = `${CommentManagerService.name}::${consolidationRunName}`;

                    const consolidationPrompt = `You are given ${partialSummaries.length} partial pull request summaries generated from different subsets of the changed files.
Merge them into a single, cohesive pull request description. Remove duplicate information and organize the content logically.
You must always respond in ${languageResultPrompt}.`;

                    const consolidationUserPrompt = partialSummaries
                        .map(
                            (s, i) =>
                                `<partialSummary index="${i + 1}">\n${s}\n</partialSummary>`,
                        )
                        .join('\n\n');

                    const consolidationResult =
                        await this.observabilityService.runLLMInSpan<string>({
                            spanName: consolidationSpanName,
                            runName: consolidationRunName,
                            attrs: spanAttrs,
                            exec: async (callbacks) => {
                                return await promptRunner
                                    .builder()
                                    .setParser(ParserType.STRING)
                                    .setLLMJsonMode(false)
                                    .setPayload(baseContext)
                                    .addPrompt({
                                        prompt: consolidationPrompt,
                                        role: PromptRole.SYSTEM,
                                    })
                                    .addPrompt({
                                        prompt: consolidationUserPrompt,
                                        role: PromptRole.USER,
                                    })
                                    .addMetadata({
                                        ...llmMetadata,
                                        runName: consolidationRunName,
                                    })
                                    .addCallbacks(callbacks)
                                    .setRunName(consolidationRunName)
                                    .setTemperature(0)
                                    .execute();
                            },
                        });

                    result = consolidationResult.result;
                }

                if (!result) {
                    this.logger.error({
                        message: `No result returned from generateSummaryPR: PR#${pullRequest?.number}`,
                        context: CommentManagerService.name,
                        metadata: { organizationAndTeamData, pullRequest },
                    });
                    throw new Error(
                        'No result returned from generateSummaryPR',
                    );
                }

                const newSummary = result || 'No summary generated';
                const startMarker = '<!-- kody-pr-summary:start -->';
                const endMarker = '<!-- kody-pr-summary:end -->';
                const blockRegex =
                    /<!-- kody-pr-summary:start -->([\s\S]*?)<!-- kody-pr-summary:end -->/;

                let finalDescription = result || 'No comment generated';

                if (isCommitRun) {
                    const commitBehaviour =
                        summaryConfig?.behaviourForNewCommits ??
                        BehaviourForNewCommits.NONE;

                    const existingBody = updatedPR?.body || '';
                    const match = existingBody.match(blockRegex);

                    this.logger.log({
                        message: `UpdateSummaryPR: ${commitBehaviour} behavior for PR#${pullRequest?.number}`,
                        context: CommentManagerService.name,
                        metadata: {
                            organizationAndTeamData,
                            pullRequestNumber: pullRequest?.number,
                            repositoryId: repository?.id,
                            summaryConfig,
                            body: updatedPR?.body,
                        },
                    });

                    switch (commitBehaviour) {
                        case BehaviourForNewCommits.NONE:
                            // Do nothing
                            break;
                        case BehaviourForNewCommits.REPLACE:
                            if (match) {
                                // Replace inside block
                                finalDescription = existingBody.replace(
                                    blockRegex,
                                    `${startMarker}\n${newSummary}\n${endMarker}`,
                                );
                            } else {
                                finalDescription = existingBody
                                    ? `${existingBody}\n\n${startMarker}\n${newSummary}\n${endMarker}`
                                    : `${startMarker}\n${newSummary}\n${endMarker}`;
                            }
                            break;
                        case BehaviourForNewCommits.CONCATENATE:
                            if (match) {
                                const currentBlockContent = match[1].trim();
                                finalDescription = existingBody.replace(
                                    blockRegex,
                                    `${startMarker}\n${currentBlockContent}\n\n---\n\n${newSummary}\n${endMarker}`,
                                );
                            } else {
                                // No block — append new one
                                finalDescription = `${existingBody}\n\n${startMarker}\n${newSummary}\n${endMarker}`;
                            }
                            break;
                        default:
                            break;
                    }
                }

                if (!isCommitRun) {
                    finalDescription = `${startMarker}\n${newSummary}\n${endMarker}`;

                    // Apply CONCATENATE behavior if necessary
                    if (
                        updatedPR?.body &&
                        summaryConfig?.behaviourForExistingDescription ===
                            BehaviourForExistingDescription.CONCATENATE
                    ) {
                        // Log for debugging
                        this.logger.log({
                            message: `GenerateSummaryPR: Concatenate behavior for PR#${pullRequest?.number}. Before concatenate`,
                            context: CommentManagerService.name,
                            metadata: {
                                organizationAndTeamData,
                                pullRequestNumber: pullRequest?.number,
                                repositoryId: repository?.id,
                                summaryConfig,
                                body: updatedPR?.body,
                            },
                        });

                        finalDescription = `${updatedPR.body}\n\n---\n\n${finalDescription}`;
                    }
                }

                this.logger.log({
                    message: `GenerateSummaryPR: End PR#${pullRequest?.number}. After concatenate`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        pullRequestNumber: pullRequest?.number,
                        repositoryId: repository?.id,
                        summaryConfig,
                        body: updatedPR?.body,
                        finalDescription,
                    },
                });

                return finalDescription.toString();
            } catch (error) {
                this.logger.error({
                    message: `Error generateOverallComment pull request: PR#${pullRequest?.number}`,
                    context: CommentManagerService.name,
                    error,
                    metadata: { organizationAndTeamData, pullRequest },
                });
                retryCount++;
                if (retryCount === maxRetries) {
                    this.logger.error({
                        message: `Error generateOverallComment pull request. Max retries exceeded: PR#${pullRequest?.number}`,
                        context: CommentManagerService.name,
                        error,
                        metadata: { organizationAndTeamData, pullRequest },
                    });
                    return null;
                }
            }
        }
    }

    async updateSummarizationInPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        summary: string,
        dryRun: CodeReviewPipelineContext['dryRun'],
    ): Promise<void> {
        try {
            if (!summary) {
                return;
            }

            await this.codeManagementService.updateDescriptionInPullRequest(
                {
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository.name,
                        id: repository.id,
                    },
                    summary,
                    dryRun,
                },
                dryRun?.enabled ? PlatformType.INTERNAL : undefined,
            );

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

    async createInitialComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        changedFiles: FileChange[],
        language: string,
        platformType: PlatformType,
        codeReviewConfig?: CodeReviewConfig,
        pullRequestMessages?: IPullRequestMessages,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<{ commentId: number; noteId: number; threadId?: number }> {
        try {
            let commentBody: string;

            if (pullRequestMessages?.startReviewMessage?.content?.length > 0) {
                const placeholderContext = await this.getTemplateContext(
                    changedFiles,
                    organizationAndTeamData,
                    prNumber,
                    codeReviewConfig,
                    language,
                    platformType,
                );

                const rawBody = await this.messageProcessor.processTemplate(
                    pullRequestMessages?.startReviewMessage?.content,
                    placeholderContext,
                );
                commentBody = this.sanitizeBitbucketMarkdown(
                    rawBody,
                    platformType,
                );
            } else {
                commentBody = await this.generatePullRequestSummaryMarkdown(
                    changedFiles,
                    language,
                    platformType,
                );

                commentBody = this.sanitizeBitbucketMarkdown(
                    commentBody,
                    platformType,
                );
            }

            if (!commentBody || commentBody.trim().length === 0) {
                commentBody = [
                    '# Code Review Started',
                    '',
                    '<!-- kody-codereview -->',
                    '&#8203;',
                ].join('\n');
            }

            const comment = await this.codeManagementService.createIssueComment(
                {
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository.name,
                        id: repository.id,
                    },
                    body: commentBody,
                    dryRun,
                },
                dryRun?.enabled ? PlatformType.INTERNAL : undefined,
            );

            if (
                PlatformType.GITHUB === platformType &&
                pullRequestMessages?.globalSettings?.hideComments
            ) {
                try {
                    await this.codeManagementService.minimizeComment(
                        {
                            organizationAndTeamData,
                            commentId: comment?.node_id
                                ? comment.node_id.toString()
                                : comment.id.toString(),
                            reason: 'OUTDATED',
                        },
                        dryRun?.enabled ? PlatformType.INTERNAL : undefined,
                    );
                } catch (error) {
                    this.logger.warn({
                        message: `Comment created but failed to minimize for PR#${prNumber}: ${error.message}`,
                        context: CommentManagerService.name,
                        metadata: {
                            organizationAndTeamData,
                            prNumber,
                            repository: repository.name,
                            commentId: comment?.id,
                        },
                    });
                }
            }

            const commentId =
                comment?.id !== undefined && comment?.id !== null
                    ? Number(comment.id)
                    : null;

            let noteId = null;
            let threadId = null;

            // Extract platform-specific IDs
            switch (platformType) {
                case PlatformType.GITLAB:
                    // GitLab uses noteId
                    noteId = comment?.notes?.[0]?.id
                        ? Number(comment.notes[0].id)
                        : null;
                    break;
                case PlatformType.AZURE_REPOS:
                    // Azure Repos uses threadId
                    threadId = comment?.threadId
                        ? Number(comment.threadId)
                        : null;
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

    async processEndReviewMessageTemplate(
        template: string,
        changedFiles: FileChange[],
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeReviewConfig?: CodeReviewConfig,
        language?: string,
        platformType?: PlatformType,
    ): Promise<string> {
        const placeholderContext = await this.getTemplateContext(
            changedFiles,
            organizationAndTeamData,
            prNumber,
            codeReviewConfig,
            language,
            platformType,
        );

        const processedBody = await this.messageProcessor.processTemplate(
            template,
            placeholderContext,
        );

        return this.sanitizeBitbucketMarkdown(processedBody, platformType);
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
        finalCommentBody?: string,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<void> {
        try {
            let commentBody = finalCommentBody;

            if (!commentBody || commentBody === '') {
                commentBody = await this.generateLastReviewCommenBody(
                    organizationAndTeamData,
                    prNumber,
                    platformType,
                    codeSuggestions,
                    codeReviewConfig,
                );
            }

            await this.codeManagementService.updateIssueComment(
                {
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
                    dryRun,
                },
                dryRun?.enabled ? PlatformType.INTERNAL : undefined,
            );

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

    private async generateLastReviewCommenBody(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        platformType: PlatformType,
        codeSuggestions?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        prLevelCommentResults?: Array<CommentResult>,
    ): Promise<string> {
        let commentBody = await this.generatePullRequestFinishSummaryMarkdown(
            organizationAndTeamData,
            prNumber,
            codeSuggestions,
            codeReviewConfig,
            prLevelCommentResults,
        );

        commentBody = this.sanitizeBitbucketMarkdown(commentBody, platformType);

        return commentBody;
    }

    async createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        lineComments: Comment[],
        language: string,
        dryRun: CodeReviewPipelineContext['dryRun'],
        suggestionCopyPrompt?: boolean,
        fallbackSuggestionsBySeverity?: FallbackSuggestionsBySeverity,
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
                    const { createdComment, attemptUsed } =
                        await this.createReviewCommentWithRetry({
                            organizationAndTeamData,
                            repository,
                            commit: lastAnalyzedCommit,
                            prNumber,
                            lineComment: comment,
                            language,
                            dryRun,
                            suggestionCopyPrompt,
                        });

                    if (attemptUsed > 1) {
                        this.logger.log({
                            message: `Comment created successfully on attempt ${attemptUsed} for PR#${prNumber}`,
                            context: CommentManagerService.name,
                            metadata: {
                                prNumber,
                                repository,
                                suggestionId: comment.suggestion?.id,
                                attemptUsed,
                                originalStartLine: comment.start_line,
                                originalEndLine: comment.line,
                            },
                        });
                    }

                    commentResults.push({
                        comment,
                        deliveryStatus: DeliveryStatus.SENT,
                        codeReviewFeedbackData: {
                            commentId: createdComment?.id,
                            pullRequestReviewId:
                                createdComment?.pull_request_review_id ??
                                createdComment?.pullRequestReviewId,
                            suggestionId: comment.suggestion.id,
                        },
                    });
                } catch (error) {
                    // Try fallback suggestion of same severity
                    const fallbackResult = await this.tryFallbackSuggestion({
                        originalComment: comment,
                        originalError: error,
                        fallbackSuggestionsBySeverity,
                        organizationAndTeamData,
                        repository,
                        commit: lastAnalyzedCommit,
                        prNumber,
                        language,
                        dryRun,
                        suggestionCopyPrompt,
                    });

                    if (fallbackResult.success) {
                        // Original suggestion was replaced
                        commentResults.push({
                            comment,
                            deliveryStatus: DeliveryStatus.REPLACED,
                        });

                        // Fallback suggestion was sent successfully
                        commentResults.push({
                            comment: fallbackResult.fallbackComment,
                            deliveryStatus: DeliveryStatus.SENT,
                            codeReviewFeedbackData: {
                                commentId: fallbackResult.createdComment?.id,
                                pullRequestReviewId:
                                    fallbackResult.createdComment
                                        ?.pull_request_review_id ??
                                    fallbackResult.createdComment
                                        ?.pullRequestReviewId,
                                suggestionId:
                                    fallbackResult.fallbackComment.suggestion
                                        .id,
                            },
                        });
                    } else {
                        // No fallback available or all fallbacks failed
                        commentResults.push({
                            comment,
                            deliveryStatus:
                                error.errorType || DeliveryStatus.FAILED,
                        });
                    }
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

    /**
     * Attempts to create a review comment with resilient retry logic.
     * Strategy:
     * - Attempt 1: Normal call with original start_line and line
     * - If line mismatch error: Attempt 2 with start_line = line (single line at end)
     * - If still line mismatch error: Attempt 3 with line = start_line (single line at start)
     * - For transient errors (5xx, network): retry once with 500ms delay
     * - Definitive errors (401, 403, 404) are not retried
     */
    private async createReviewCommentWithRetry(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; language: string };
        commit: any;
        prNumber: number;
        lineComment: Comment;
        language: string;
        dryRun: CodeReviewPipelineContext['dryRun'];
        suggestionCopyPrompt?: boolean;
    }): Promise<{ createdComment: any; attemptUsed: number }> {
        const { lineComment, dryRun, ...restParams } = params;
        const NON_RETRYABLE_STATUS_CODES = [401, 403, 404];
        const TRANSIENT_RETRY_DELAY_MS = 500;

        const isLineMismatchError = (error: any): boolean => {
            return error?.errorType === 'failed_lines_mismatch';
        };

        const isTransientError = (error: any): boolean => {
            const status = error?.status || error?.response?.status;
            if (status >= 500 && status < 600) return true;
            if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT')
                return true;
            return false;
        };

        const isNonRetryableError = (error: any): boolean => {
            const status = error?.status || error?.response?.status;
            return NON_RETRYABLE_STATUS_CODES.includes(status);
        };

        const sleep = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms));

        const attemptCreateComment = async (comment: Comment): Promise<any> => {
            return this.codeManagementService.createReviewComment(
                {
                    ...restParams,
                    lineComment: comment,
                    dryRun,
                },
                dryRun?.enabled ? PlatformType.INTERNAL : undefined,
            );
        };

        // Attempt 1: Original lines
        try {
            const createdComment = await attemptCreateComment(lineComment);
            return { createdComment, attemptUsed: 1 };
        } catch (error) {
            if (isNonRetryableError(error)) {
                throw error;
            }

            // For transient errors, retry once with delay
            if (isTransientError(error)) {
                this.logger.warn({
                    message: `Transient error creating comment, retrying after ${TRANSIENT_RETRY_DELAY_MS}ms`,
                    context: CommentManagerService.name,
                    metadata: {
                        prNumber: params.prNumber,
                        suggestionId: lineComment.suggestion?.id,
                        errorCode: error?.code,
                        errorStatus: error?.status,
                    },
                });

                await sleep(TRANSIENT_RETRY_DELAY_MS);

                const createdComment = await attemptCreateComment(lineComment);
                return { createdComment, attemptUsed: 1 };
            }

            // For line mismatch errors, try adjusting lines
            if (!isLineMismatchError(error)) {
                throw error;
            }

            this.logger.warn({
                message: `Line mismatch error on attempt 1, trying with start_line = line`,
                context: CommentManagerService.name,
                metadata: {
                    prNumber: params.prNumber,
                    suggestionId: lineComment.suggestion?.id,
                    originalStartLine: lineComment.start_line,
                    originalEndLine: lineComment.line,
                },
            });

            // Attempt 2: Set start_line = line (single line at end position)
            const commentAttempt2: Comment = {
                ...lineComment,
                start_line: lineComment.line,
            };

            try {
                const createdComment =
                    await attemptCreateComment(commentAttempt2);
                return { createdComment, attemptUsed: 2 };
            } catch (error2) {
                if (
                    isNonRetryableError(error2) ||
                    !isLineMismatchError(error2)
                ) {
                    throw error2;
                }

                this.logger.warn({
                    message: `Line mismatch error on attempt 2, trying with line = start_line`,
                    context: CommentManagerService.name,
                    metadata: {
                        prNumber: params.prNumber,
                        suggestionId: lineComment.suggestion?.id,
                        originalStartLine: lineComment.start_line,
                        originalEndLine: lineComment.line,
                    },
                });

                // Attempt 3: Set line = start_line (single line at start position)
                const commentAttempt3: Comment = {
                    ...lineComment,
                    line: lineComment.start_line,
                };

                const createdComment =
                    await attemptCreateComment(commentAttempt3);
                return { createdComment, attemptUsed: 3 };
            }
        }
    }

    /**
     * Attempts to find and comment a fallback suggestion of the same severity
     * when the original suggestion fails all retry attempts.
     * Keeps trying until a fallback succeeds or no more fallbacks are available.
     */
    private async tryFallbackSuggestion(params: {
        originalComment: Comment;
        originalError: any;
        fallbackSuggestionsBySeverity?: FallbackSuggestionsBySeverity;
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string; language: string };
        commit: any;
        prNumber: number;
        language: string;
        dryRun: CodeReviewPipelineContext['dryRun'];
        suggestionCopyPrompt?: boolean;
    }): Promise<{
        success: boolean;
        fallbackComment?: Comment;
        createdComment?: any;
    }> {
        const {
            originalComment,
            fallbackSuggestionsBySeverity,
            organizationAndTeamData,
            repository,
            commit,
            prNumber,
            language,
            dryRun,
            suggestionCopyPrompt,
        } = params;

        // If no fallback suggestions available, return failure
        if (!fallbackSuggestionsBySeverity) {
            return { success: false };
        }

        const originalSeverity =
            (originalComment.suggestion?.severity?.toLowerCase() as keyof FallbackSuggestionsBySeverity) ||
            'low';

        const fallbackArray = fallbackSuggestionsBySeverity[originalSeverity];

        // If no fallbacks for this severity, return failure
        if (!fallbackArray || fallbackArray.length === 0) {
            this.logger.log({
                message: `No fallback suggestions available for severity ${originalSeverity}`,
                context: CommentManagerService.name,
                metadata: {
                    prNumber,
                    originalSuggestionId: originalComment.suggestion?.id,
                    severity: originalSeverity,
                },
            });
            return { success: false };
        }

        // Try each available fallback suggestion until one succeeds
        for (const fallbackSuggestion of fallbackArray) {
            // Skip if already repriorized (already attempted)
            if (
                fallbackSuggestion.priorityStatus === PriorityStatus.REPRIORIZED
            ) {
                continue;
            }

            // Mark as repriorized before attempting (mutate original object)
            fallbackSuggestion.priorityStatus = PriorityStatus.REPRIORIZED;

            this.logger.log({
                message: `Attempting fallback suggestion for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: {
                    prNumber,
                    originalSuggestionId: originalComment.suggestion?.id,
                    fallbackSuggestionId: fallbackSuggestion.id,
                    severity: originalSeverity,
                },
            });

            // Build comment from fallback suggestion
            const fallbackComment = buildCommentFromSuggestion(
                fallbackSuggestion,
                repository.language,
            );

            try {
                const { createdComment } =
                    await this.createReviewCommentWithRetry({
                        organizationAndTeamData,
                        repository,
                        commit,
                        prNumber,
                        lineComment: fallbackComment,
                        language,
                        dryRun,
                        suggestionCopyPrompt,
                    });

                this.logger.log({
                    message: `Fallback suggestion commented successfully for PR#${prNumber}`,
                    context: CommentManagerService.name,
                    metadata: {
                        prNumber,
                        originalSuggestionId: originalComment.suggestion?.id,
                        fallbackSuggestionId: fallbackSuggestion.id,
                        severity: originalSeverity,
                    },
                });

                return {
                    success: true,
                    fallbackComment,
                    createdComment,
                };
            } catch (fallbackError) {
                this.logger.warn({
                    message: `Fallback suggestion also failed for PR#${prNumber}, trying next`,
                    context: CommentManagerService.name,
                    metadata: {
                        prNumber,
                        originalSuggestionId: originalComment.suggestion?.id,
                        fallbackSuggestionId: fallbackSuggestion.id,
                        severity: originalSeverity,
                        errorType: fallbackError?.errorType,
                    },
                });
                // Continue to next fallback
            }
        }

        // All fallbacks exhausted
        this.logger.log({
            message: `All fallback suggestions exhausted for severity ${originalSeverity}`,
            context: CommentManagerService.name,
            metadata: {
                prNumber,
                originalSuggestionId: originalComment.suggestion?.id,
                severity: originalSeverity,
            },
        });

        return { success: false };
    }

    private async generatePullRequestFinishSummaryMarkdown(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        commentResults?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        prLevelCommentResults?: Array<CommentResult>,
    ): Promise<string> {
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

            const hasPrLevelComments = !!prLevelCommentResults?.filter(
                (comment) => comment.deliveryStatus === DeliveryStatus.SENT,
            ).length;

            const hasFileComments = !!commentResults?.filter(
                (comment) => comment.deliveryStatus === DeliveryStatus.SENT,
            ).length;

            const hasComments = hasPrLevelComments || hasFileComments;

            const resultText = hasComments
                ? translation.withComments
                : translation.withoutComments;

            if (!resultText) {
                throw new Error(
                    `No result text found for language: ${language}`,
                );
            }

            // Add unique tag with timestamp to identify this comment as completed
            const uniqueId = `completed-${Date.now()}-${Math.random().toString(36).slice(2)}`;

            return `${resultText}\n\n${await this.generateConfigReviewMarkdown(organizationAndTeamData, prNumber, codeReviewConfig)}\n\n<!-- kody-codereview-${uniqueId} -->\n<!-- kody-codereview -->\n&#8203;`;
        } catch (error) {
            this.logger.error({
                message:
                    'Error generating pull request finish summary markdown',
                context: CommentManagerService.name,
                error: error.message,
                metadata: { commentResults, organizationAndTeamData, prNumber },
            });

            const fallbackText = '## Code Review Completed! 🔥';
            const uniqueId = `completed-${Date.now()}-${Math.random().toString(36).slice(2)}`;

            return `${fallbackText}\n\n<!-- kody-codereview-${uniqueId} -->\n<!-- kody-codereview -->\n&#8203;`;
        }
    }

    /**
     * Generates the Pull Request summary markdown based on the changed files.
     */
    private async generatePullRequestSummaryMarkdown(
        changedFiles: FileChange[],
        language: string,
        platformType: PlatformType,
    ): Promise<string> {
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

            // Use the processor to generate dynamic parts
            const context: PlaceholderContext = {
                changedFiles,
                language,
                platformType,
            };

            const filesTableContent =
                await this.messageProcessor.processTemplate(
                    '@changedFiles',
                    context,
                );
            const summaryContent = await this.messageProcessor.processTemplate(
                '@changeSummary',
                context,
            );

            return `
# ${translation.title}

## ${translation.codeReviewStarted}

${translation.description}

${filesTableContent}

${summaryContent}

<!-- kody-codereview -->\n&#8203;`.trim();
        } catch (error) {
            this.logger.error({
                message: 'Error generating pull request summary markdown',
                context: CommentManagerService.name,
                error: error.message,
                metadata: { changedFiles, language },
            });

            return '';
        }
    }

    private async generateConfigReviewMarkdown(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeReviewConfig: CodeReviewConfig,
    ): Promise<string> {
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
            const context: PlaceholderContext = {
                codeReviewConfig,
                language,
                organizationAndTeamData,
                prNumber,
            };

            const reviewOptions = await this.messageProcessor.processTemplate(
                '@reviewOptions',
                context,
            );

            return `
<details>
<summary>${translation.title}</summary>

<details>
<summary>${translation.interactingTitle}</summary>

- **${translation.requestReview}:** ${translation.requestReviewDesc}

- **${translation.validateBusinessLogic}:** ${translation.validateBusinessLogicDesc}

- **${translation.provideFeedback}:** ${translation.provideFeedbackDesc}

</details>

<details>
<summary>${translation.configurationTitle}</summary>

${reviewOptions}

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
        byokConfig?: BYOKConfig,
    ) {
        const language = (
            await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;

        const baseContext = { codeSuggestions, language };
        let repeteadSuggetionsClustered;

        try {
            const fallbackProvider =
                provider === LLMModelProvider.OPENAI_GPT_4O
                    ? LLMModelProvider.NOVITA_DEEPSEEK_V3
                    : LLMModelProvider.OPENAI_GPT_4O;

            const userPrompt = `<codeSuggestionsContext>${JSON.stringify(baseContext?.codeSuggestions) || 'No code suggestions provided'}</codeSuggestionsContext>`;

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                provider,
                fallbackProvider,
                byokConfig,
            );

            const runName = 'repeatedCodeReviewSuggestionClustering';
            const spanName = `${CommentManagerService.name}::${runName}`;
            const spanAttrs = {
                type: promptRunner.executeMode,
                organizationId: organizationAndTeamData?.organizationId,
                prNumber,
            };

            const { result } =
                await this.observabilityService.runLLMInSpan<string>({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    exec: async (callbacks) => {
                        return await promptRunner
                            .builder()
                            .setParser(ParserType.STRING)
                            .setLLMJsonMode(true)
                            .setPayload(baseContext)
                            .addPrompt({
                                prompt: prompt_repeated_suggestion_clustering_system,
                                role: PromptRole.SYSTEM,
                            })
                            .addPrompt({
                                prompt: userPrompt,
                                role: PromptRole.USER,
                            })
                            .addMetadata({
                                organizationId:
                                    organizationAndTeamData?.organizationId,
                                teamId: organizationAndTeamData?.teamId,
                                pullRequestId: prNumber,
                                provider:
                                    byokConfig?.main?.provider || provider,
                                model: byokConfig?.main?.model,
                                fallbackProvider:
                                    byokConfig?.fallback?.provider ||
                                    fallbackProvider,
                                fallbackModel: byokConfig?.fallback?.model,
                                runName,
                            })
                            .addCallbacks(callbacks)
                            .setRunName(runName)
                            .setTemperature(0)
                            .execute();
                    },
                });

            if (!result) {
                const message =
                    'No result returned from repeated code review suggestion clustering';
                this.logger.error({
                    message,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        provider: byokConfig?.main?.provider || provider,
                        fallbackProvider:
                            byokConfig?.fallback?.provider || fallbackProvider,
                    },
                });
                throw new Error(message);
            }

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

            return codeSuggestions;
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
        // PERF: filter já cria novo array, não precisa copiar objetos
        return originalSuggestions.filter(
            (suggestion) => !clusteredIds.has(suggestion.id),
        );
    }

    private async enrichClusteredSuggestions(
        originalSuggestions: any[],
        clusteredSuggestions: ClusteredSuggestion[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const enrichedSuggestions: Partial<CodeSuggestion>[] = [];

        // PERF: Create lookup map for O(1) access instead of O(n) find per iteration
        const suggestionsMap = new Map(
            originalSuggestions.map((s) => [s.id, s]),
        );

        for (const cluster of clusteredSuggestions) {
            const parentSuggestion = this.enrichParentSuggestion(
                suggestionsMap,
                cluster,
            );
            enrichedSuggestions.push(parentSuggestion);

            const relatedSuggestions = this.enrichRelatedSuggestions(
                suggestionsMap,
                cluster,
            );
            enrichedSuggestions.push(...relatedSuggestions);
        }

        return enrichedSuggestions;
    }

    private enrichParentSuggestion(
        suggestionsMap: Map<string, any>,
        cluster: ClusteredSuggestion,
    ): Partial<CodeSuggestion> {
        const originalSuggestion = suggestionsMap.get(cluster.id);

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

    private enrichRelatedSuggestions(
        suggestionsMap: Map<string, any>,
        cluster: ClusteredSuggestion,
    ): Partial<CodeSuggestion>[] {
        return cluster.sameSuggestionsId.map((id) => {
            const originalSuggestion = suggestionsMap.get(id);

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
        // PERF: Build lookup map of RELATED suggestions grouped by parentSuggestionId
        // This avoids O(n²) from filtering inside map
        const relatedByParentId = new Map<string, CodeSuggestion[]>();
        for (const s of suggestions) {
            if (
                s.clusteringInformation?.type === ClusteringType.RELATED &&
                s.clusteringInformation?.parentSuggestionId
            ) {
                const parentId = s.clusteringInformation.parentSuggestionId;
                if (!relatedByParentId.has(parentId)) {
                    relatedByParentId.set(parentId, []);
                }
                relatedByParentId.get(parentId)!.push(s);
            }
        }

        return suggestions.map((suggestion) => {
            if (
                suggestion.clusteringInformation?.type !== ClusteringType.PARENT
            ) {
                return suggestion;
            }

            const relatedSuggestions =
                relatedByParentId.get(suggestion.id) || [];

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

    /**
     * Creates general comments on the PR for PR-level suggestions
     */
    async createPrLevelReviewComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        prLevelSuggestions: ISuggestionByPR[],
        language: string,
        suggestionCopyPrompt?: boolean,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<{ commentResults: Array<CommentResult> }> {
        try {
            if (!prLevelSuggestions?.length) {
                this.logger.log({
                    message: `No PR-level suggestions to create comments for PR#${prNumber}`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repository,
                    },
                });
                return { commentResults: [] };
            }

            this.logger.log({
                message: `Creating PR-level comments for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    suggestionsCount: prLevelSuggestions.length,
                },
            });

            const commentResults = [];

            for (const suggestion of prLevelSuggestions) {
                try {
                    // Use standardized formatting method
                    const commentBody =
                        await this.codeManagementService.formatReviewCommentBody(
                            {
                                suggestion,
                                repository,
                                includeHeader: true, // PR-level always includes header with badges
                                includeFooter: false, // PR-level does NOT include interaction footer
                                language,
                                organizationAndTeamData,
                                suggestionCopyPrompt,
                            },
                            dryRun?.enabled ? PlatformType.INTERNAL : undefined,
                        );

                    // Create general comment
                    const createdComment =
                        await this.codeManagementService.createIssueComment(
                            {
                                organizationAndTeamData,
                                repository: {
                                    name: repository.name,
                                    id: repository.id,
                                },
                                prNumber,
                                body: commentBody,
                                dryRun,
                                suggestion,
                            },
                            dryRun?.enabled ? PlatformType.INTERNAL : undefined,
                        );

                    if (createdComment?.id) {
                        commentResults.push({
                            comment: {
                                suggestion,
                                body: commentBody,
                                type: 'pr_level',
                            },
                            deliveryStatus: DeliveryStatus.SENT,
                            codeReviewFeedbackData: {
                                commentId: createdComment.id,
                                pullRequestReviewId: null, // PR-level comments do not have review ID
                                suggestionId: suggestion.id,
                            },
                        });

                        this.logger.log({
                            message: `Created PR-level comment for suggestion ${suggestion.id}`,
                            context: CommentManagerService.name,
                            metadata: {
                                suggestionId: suggestion.id,
                                commentId: createdComment.id,
                                category: suggestion.label,
                                severity: suggestion.severity,
                                pullRequestNumber: prNumber,
                            },
                        });
                    } else {
                        commentResults.push({
                            comment: {
                                suggestion,
                                body: commentBody,
                                type: 'pr_level',
                            },
                            deliveryStatus: DeliveryStatus.FAILED,
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error creating PR-level comment for suggestion ${suggestion.id}`,
                        context: CommentManagerService.name,
                        error,
                        metadata: {
                            suggestionId: suggestion.id,
                            pullRequestNumber: prNumber,
                            organizationId:
                                organizationAndTeamData.organizationId,
                            repository,
                        },
                    });

                    commentResults.push({
                        comment: {
                            suggestion,
                            type: 'pr_level',
                        },
                        deliveryStatus: DeliveryStatus.FAILED,
                    });
                }
            }

            return { commentResults };
        } catch (error) {
            this.logger.error({
                message: `Failed to create PR-level comments for PR#${prNumber}`,
                context: CommentManagerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    suggestionsCount: prLevelSuggestions?.length,
                },
            });

            return { commentResults: [] };
        }
    }

    /**
     * Finds the last completed code review comment on a PR
     * using the tag <!-- kody-codereview-completed-{uniqueId} -->
     */
    async findLastReviewComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
    ): Promise<{ commentId: number; nodeId?: string } | null> {
        try {
            if (platformType !== PlatformType.GITHUB) {
                return null;
            }

            const comments =
                await this.codeManagementService.getAllCommentsInPullRequest({
                    organizationAndTeamData,
                    repository,
                    prNumber,
                });

            if (!comments?.length) {
                return null;
            }

            // ✅ SIMPLE: Filters only by HTML tag + sorts by date
            const completedReviewComments = comments
                .filter((comment: any) => {
                    const body = comment.body || '';
                    return body.includes('<!-- kody-codereview-completed-');
                })
                .sort(
                    (a, b) =>
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime(),
                );

            if (!completedReviewComments.length) {
                return null;
            }

            // Get the most recent (first after sorting)
            const lastReviewComment = completedReviewComments[0];

            return {
                commentId: lastReviewComment.id,
                nodeId: lastReviewComment.node_id,
            };
        } catch (error) {
            this.logger.error({
                message: `Failed to find last review comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
            });
            return null;
        }
    }

    /**
     * Minimizes the last completed code review comment on a PR
     * to avoid spam on the timeline when there are multiple reviews
     */
    async minimizeLastReviewComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
    ): Promise<boolean> {
        try {
            if (platformType !== PlatformType.GITHUB) {
                this.logger.log({
                    message: `Skipping minimize comment for PR#${prNumber} - platform ${platformType} not supported`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        platformType,
                        prNumber,
                    },
                });
                return false;
            }

            // Find the last completed review comment
            const lastReviewComment = await this.findLastReviewComment(
                organizationAndTeamData,
                prNumber,
                repository,
                platformType,
            );

            if (!lastReviewComment) {
                this.logger.log({
                    message: `No previous review comment found to minimize for PR#${prNumber}`,
                    context: CommentManagerService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repository: repository.name,
                    },
                });
                return false;
            }

            // Minimize the comment using nodeId (GraphQL ID) if available, otherwise use commentId
            const commentIdToMinimize =
                lastReviewComment.nodeId || lastReviewComment.commentId;

            await this.codeManagementService.minimizeComment({
                organizationAndTeamData,
                commentId: commentIdToMinimize.toString(),
                reason: 'OUTDATED',
            });

            this.logger.log({
                message: `Successfully minimized previous review comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                metadata: {
                    commentId: lastReviewComment.commentId,
                    nodeId: lastReviewComment.nodeId,
                    prNumber,
                    organizationAndTeamData,
                },
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: `Failed to minimize last review comment for PR#${prNumber}`,
                context: CommentManagerService.name,
                error: error.message,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repository,
                    platformType,
                },
            });
            return false;
        }
    }

    async createComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
        changedFiles?: FileChange[],
        language?: string,
        codeSuggestions?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        endReviewMessage?: string,
        pullRequestMessagesConfig?: IPullRequestMessages,
        dryRun?: CodeReviewPipelineContext['dryRun'],
        prLevelCommentResults?: Array<CommentResult>,
    ): Promise<void> {
        let commentBody: string;

        if (endReviewMessage) {
            commentBody = endReviewMessage;

            const placeholderContext = await this.getTemplateContext(
                changedFiles,
                organizationAndTeamData,
                prNumber,
                codeReviewConfig,
                language,
                platformType,
            );

            const rawBody = await this.messageProcessor.processTemplate(
                endReviewMessage,
                placeholderContext,
            );

            commentBody = this.sanitizeBitbucketMarkdown(rawBody, platformType);
        } else {
            commentBody = await this.generateLastReviewCommenBody(
                organizationAndTeamData,
                prNumber,
                platformType,
                codeSuggestions,
                codeReviewConfig,
                prLevelCommentResults,
            );
        }

        const comment = await this.codeManagementService.createIssueComment(
            {
                organizationAndTeamData,
                repository,
                prNumber,
                body: commentBody,
            },
            dryRun?.enabled ? PlatformType.INTERNAL : undefined,
        );

        if (
            platformType === PlatformType.GITHUB &&
            pullRequestMessagesConfig?.globalSettings?.hideComments &&
            !dryRun?.enabled
        ) {
            await this.codeManagementService.minimizeComment({
                organizationAndTeamData,
                commentId: comment?.node_id
                    ? comment.node_id.toString()
                    : comment.id.toString(),
                reason: 'OUTDATED',
            });
        }

        return comment;
    }

    private async getTemplateContext(
        changedFiles?: FileChange[],
        organizationAndTeamData?: OrganizationAndTeamData,
        prNumber?: number,
        codeReviewConfig?: CodeReviewConfig,
        language?: string,
        platformType?: PlatformType,
    ): Promise<PlaceholderContext> {
        return {
            changedFiles,
            organizationAndTeamData,
            prNumber,
            codeReviewConfig,
            language,
            platformType,
        };
    }

    /**
     * Splits changedFiles into chunks that fit within the maxInputTokens budget.
     *
     * @returns Array of file groups (1–4 chunks), or null if more than 4 chunks
     *          would be needed (caller should skip summary generation).
     *          When maxInputTokens is not configured, returns a single chunk
     *          containing all files.
     */
    private chunkChangedFilesForSummary(
        changedFiles: Partial<FileChange>[],
        promptBase: string,
        userPromptPrefix: string,
        maxInputTokens?: number,
    ): Partial<FileChange>[][] | null {
        // No limit configured — return all files as a single chunk
        if (!maxInputTokens || maxInputTokens <= 0) {
            return [changedFiles];
        }

        const MAX_CHUNKS = 4;

        // Apply 90% safety margin
        const effectiveBudget = Math.floor(maxInputTokens * 0.9);

        // Estimate fixed token cost (system prompt + user prompt wrapper)
        const fixedTokens =
            estimateTokens(promptBase) +
            estimateTokens(userPromptPrefix) +
            estimateTokens('<changedFilesContext></changedFilesContext>') +
            50; // tags and minor overhead

        const availableTokens = effectiveBudget - fixedTokens;

        if (availableTokens <= 0) {
            // Budget consumed by fixed parts alone — send all best-effort
            return [changedFiles];
        }

        // Check if all files fit in a single call
        const allFilesSerialized = JSON.stringify(changedFiles);
        const totalTokens = estimateTokens(allFilesSerialized);

        if (totalTokens <= availableTokens) {
            return [changedFiles];
        }

        // Need to split — group files into chunks by token cost
        const maxCharsPerChunk = tokensToChars(availableTokens);

        const chunks: Partial<FileChange>[][] = [];
        let currentChunk: Partial<FileChange>[] = [];
        let currentChunkChars = 2; // start with "[]" for JSON array wrapper

        for (const file of changedFiles) {
            const fileSerialized = JSON.stringify(file);
            // +1 for the comma separator between items in JSON array
            const fileChars = fileSerialized.length + 1;

            if (
                currentChunkChars + fileChars > maxCharsPerChunk &&
                currentChunk.length > 0
            ) {
                chunks.push(currentChunk);

                if (chunks.length > MAX_CHUNKS) {
                    return null;
                }

                currentChunk = [file];
                currentChunkChars = 2 + fileSerialized.length;
            } else {
                currentChunk.push(file);
                currentChunkChars += fileChars;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        if (chunks.length > MAX_CHUNKS) {
            return null;
        }

        return chunks;
    }
}
