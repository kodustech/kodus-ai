import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { createLogger } from '@libs/core/log/logger';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

@Injectable()
export class CreatePrLevelCommentsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreatePrLevelCommentsStage';
    readonly label = 'Posting PR Comments';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;
    private readonly logger = createLogger(CreatePrLevelCommentsStage.name);

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            // Validações fundamentais de segurança
            if (!context?.organizationAndTeamData) {
                this.logger.error({
                    message: 'Missing organizationAndTeamData in context',
                    context: this.stageName,
                });
                return context;
            }

            if (!context?.pullRequest?.number) {
                this.logger.error({
                    message: 'Missing pullRequest data in context',
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });
                return context;
            }

            if (!context?.repository?.name || !context?.repository?.id) {
                this.logger.error({
                    message: 'Missing repository data in context',
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });
                return context;
            }

            // Verificar se há sugestões de nível de PR para processar
            const prLevelSuggestions = [
                ...(context?.validSuggestionsByPR ?? []),
                ...(context?.businessLogicResults ?? []),
            ];

            if (prLevelSuggestions.length === 0) {
                this.logger.log({
                    message: `No PR-level suggestions to process for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });
                return context;
            }

            try {
                this.logger.log({
                    message: `Starting PR-level comments creation for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        suggestionsCount: prLevelSuggestions.length,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });

                let commentResults: any[] = [];

                try {
                    // Criar comentários para cada sugestão de nível de PR usando o commentManagerService
                    const result =
                        await this.commentManagerService.createPrLevelReviewComments(
                            context.organizationAndTeamData,
                            context.pullRequest.number,
                            {
                                name: context.repository.name,
                                id: context.repository.id,
                                language: context.repository.language || '',
                            },
                            prLevelSuggestions,
                            context.codeReviewConfig?.languageResultPrompt,
                            context.pullRequestMessagesConfig?.globalSettings
                                ?.suggestionCopyPrompt,
                        );

                    commentResults = result?.commentResults || [];

                    // Only count comments that were actually delivered. The
                    // underlying platform call can fail (e.g. GitHub 503) and
                    // still return a result entry with deliveryStatus=FAILED.
                    // Keep the full result set for persistence/auditing, but
                    // report delivered vs failed counts separately.
                    const deliveredResults = commentResults.filter(
                        (r: any) =>
                            r?.deliveryStatus === DeliveryStatus.SENT ||
                            r?.deliveryStatus === 'sent',
                    );
                    const failedCount =
                        commentResults.length - deliveredResults.length;

                    if (deliveredResults.length > 0) {
                        this.logger.log({
                            message: `Successfully created ${deliveredResults.length} PR-level comments for PR#${context.pullRequest.number}`,
                            context: this.stageName,
                            metadata: {
                                prNumber: context.pullRequest.number,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                suggestionsCount: prLevelSuggestions.length,
                                commentsCreated: deliveredResults.length,
                                commentsFailed: failedCount,
                            },
                        });
                    }

                    if (failedCount > 0) {
                        this.logger.warn({
                            message: `${failedCount} PR-level comment(s) failed to deliver for PR#${context.pullRequest.number}`,
                            context: this.stageName,
                            metadata: {
                                prNumber: context.pullRequest.number,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                suggestionsCount: prLevelSuggestions.length,
                                commentsFailed: failedCount,
                            },
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Error creating PR level comments for PR#${context.pullRequest.number}`,
                        context: this.stageName,
                        error,
                        metadata: {
                            prNumber: context.pullRequest.number,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            suggestionsCount: prLevelSuggestions.length,
                        },
                    });
                    // Continua sem comentários
                    commentResults = [];
                }

                // Transformar commentResults em ISuggestionByPR e salvar no banco
                if (commentResults && commentResults.length > 0) {
                    try {
                        const transformedPrLevelSuggestions =
                            this.suggestionService.transformCommentResultsToPrLevelSuggestions(
                                commentResults,
                            );

                        if (transformedPrLevelSuggestions?.length > 0) {
                            try {
                                await this.pullRequestsService.addPrLevelSuggestions(
                                    context.pullRequest.number,
                                    context.repository.name,
                                    transformedPrLevelSuggestions,
                                    context.organizationAndTeamData,
                                );

                                this.logger.log({
                                    message: `Saved ${transformedPrLevelSuggestions.length} PR level suggestions to database`,
                                    context: this.stageName,
                                    metadata: {
                                        prNumber: context.pullRequest.number,
                                        repositoryName: context.repository.name,
                                        suggestionsCount:
                                            transformedPrLevelSuggestions.length,
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                    },
                                });
                            } catch (error) {
                                this.logger.error({
                                    message: `Error saving PR level suggestions to database`,
                                    context: this.stageName,
                                    error,
                                    metadata: {
                                        prNumber: context.pullRequest.number,
                                        repositoryName: context.repository.name,
                                        organizationAndTeamData:
                                            context.organizationAndTeamData,
                                    },
                                });
                                // Continua sem salvar no banco
                            }
                        }
                    } catch (error) {
                        this.logger.error({
                            message: `Error transforming comment results to PR level suggestions`,
                            context: this.stageName,
                            error,
                            metadata: {
                                prNumber: context.pullRequest.number,
                                organizationAndTeamData:
                                    context.organizationAndTeamData,
                                commentResultsCount: commentResults.length,
                            },
                        });
                        // Continua sem transformar
                    }
                }

                // Adicionar os resultados dos comentários ao contexto
                const finalContext = this.updateContext(context, (draft) => {
                    // Armazenar os resultados dos comentários de nível de PR
                    if (!draft.prLevelCommentResults) {
                        draft.prLevelCommentResults = [];
                    }

                    if (commentResults && commentResults?.length > 0) {
                        draft.prLevelCommentResults.push(...commentResults);
                    }
                });

                return finalContext;
            } catch (error) {
                this.logger.error({
                    message: `Error during PR-level comments creation for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    error,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        suggestionsCount: prLevelSuggestions.length,
                    },
                });

                return context;
            }
        } catch (error) {
            this.logger.error({
                message: `Error during PR-level comments creation for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });
            return context;
        }
    }
}
