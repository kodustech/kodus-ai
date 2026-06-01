import { createLogger, createThreadId } from '@kodus/flow';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import {
    CROSS_FILE_ANALYSIS_SERVICE_TOKEN,
    CrossFileAnalysisService,
} from '@libs/code-review/infrastructure/adapters/services/crossFileAnalysis.service';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import {
    KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN,
    KodyRulesPrLevelAnalysisService,
} from '@libs/ee/codeBase/kodyRulesPrLevelAnalysis.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class ProcessFilesPrLevelReviewStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(ProcessFilesPrLevelReviewStage.name);
    readonly stageName = 'PRLevelReviewStage';
    readonly label = 'Reviewing PR Level';
    readonly visibility = StageVisibility.PRIMARY;
    private static readonly REQUIREMENT_KEYWORDS = [
        'requirement',
        'acceptance criteria',
        'user story',
        'given',
        'when',
        'then',
    ];
    private static readonly BUSINESS_LOGIC_TIMEOUT_MS = 300_000;

    constructor(
        @Inject(KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN)
        private readonly kodyRulesPrLevelAnalysisService: KodyRulesPrLevelAnalysisService,

        @Inject(CROSS_FILE_ANALYSIS_SERVICE_TOKEN)
        private readonly crossFileAnalysisService: CrossFileAnalysisService,

        private readonly businessRulesValidationAgentProvider: BusinessRulesValidationAgentProvider,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
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
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return context;
        }

        if (!context?.repository?.name || !context?.repository?.id) {
            this.logger.error({
                message: 'Missing repository data in context',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });
            return context;
        }

        // Business logic validation does not require changedFiles — run it regardless.
        // File-level analyses (kody rules, cross-file) are skipped when no files changed.
        const businessLogicPromise = this.runBusinessLogicValidation(context);

        if (!context?.changedFiles?.length) {
            this.logger.warn({
                message: `No files to analyze for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                    prNumber: context.pullRequest.number,
                },
            });

            const businessLogicSettled = await Promise.allSettled([
                businessLogicPromise,
            ]);
            const businessLogicContext =
                businessLogicSettled[0].status === 'fulfilled'
                    ? businessLogicSettled[0].value
                    : null;
            const businessLogicError =
                businessLogicSettled[0].status === 'rejected'
                    ? this.settledError(
                          businessLogicSettled[0],
                          'BusinessLogicValidation',
                          context,
                      )
                    : undefined;

            if (businessLogicSettled[0].status === 'rejected') {
                this.logger.error({
                    message: `BusinessLogicValidation settled as rejected for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    error: (businessLogicSettled[0] as PromiseRejectedResult)
                        .reason,
                });
            }

            if (!businessLogicError) {
                return businessLogicContext ?? context;
            }

            return this.updateContext(
                businessLogicContext ?? context,
                (draft) => {
                    draft.errors.push(businessLogicError);
                },
            );
        }

        const [kodyRulesSettled, crossFileSettled, businessLogicSettled] =
            await Promise.allSettled([
                this.runKodyRulesAnalysis(context),
                this.runCrossFileAnalysis(context),
                businessLogicPromise,
            ]);

        const kodyRulesResult =
            kodyRulesSettled.status === 'fulfilled'
                ? kodyRulesSettled.value
                : {
                      suggestions: [],
                      error: this.settledError(
                          kodyRulesSettled,
                          'KodyRulesAnalysis',
                          context,
                      ),
                  };

        const crossFileResult =
            crossFileSettled.status === 'fulfilled'
                ? crossFileSettled.value
                : {
                      suggestions: [],
                      error: this.settledError(
                          crossFileSettled,
                          'CrossFileAnalysis',
                          context,
                      ),
                  };

        const businessLogicContext =
            businessLogicSettled.status === 'fulfilled'
                ? businessLogicSettled.value
                : null;
        const businessLogicError =
            businessLogicSettled.status === 'rejected'
                ? this.settledError(
                      businessLogicSettled,
                      'BusinessLogicValidation',
                      context,
                  )
                : undefined;

        if (businessLogicSettled.status === 'rejected') {
            this.logger.error({
                message: `BusinessLogicValidation settled as rejected for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error: businessLogicSettled.reason,
            });
        }

        return this.updateContext(businessLogicContext ?? context, (draft) => {
            // Kody Rules Results
            if (kodyRulesResult?.suggestions?.length > 0) {
                if (!draft.validSuggestionsByPR) {
                    draft.validSuggestionsByPR = [];
                }
                draft.validSuggestionsByPR.push(...kodyRulesResult.suggestions);
            }

            // Cross File Results
            if (crossFileResult?.suggestions?.length > 0) {
                if (!draft.prAnalysisResults) {
                    draft.prAnalysisResults = {};
                }
                if (!draft.prAnalysisResults.validCrossFileSuggestions) {
                    draft.prAnalysisResults.validCrossFileSuggestions = [];
                }
                draft.prAnalysisResults.validCrossFileSuggestions.push(
                    ...crossFileResult.suggestions,
                );
            }

            // Aggregate Errors
            if (kodyRulesResult?.error) {
                draft.errors.push(kodyRulesResult.error);
            }

            if (crossFileResult?.error) {
                draft.errors.push(crossFileResult.error);
            }

            if (businessLogicError) {
                draft.errors.push(businessLogicError);
            }
        });
    }

    private async runKodyRulesAnalysis(
        _context: CodeReviewPipelineContext,
    ): Promise<{ suggestions: ISuggestionByPR[]; error?: PipelineError }> {
        // Kody Rules (file + PR level) are handled by the KodyRulesAgent
        // in the AgentReviewStage. No longer needed here.
        return { suggestions: [] };
    }

    private async runCrossFileAnalysis(
        context: CodeReviewPipelineContext,
    ): Promise<{ suggestions: CodeSuggestion[]; error?: PipelineError }> {
        // Agents handle cross-file investigation via tools (grep, readFile)
        this.logger.log({
            message: `Skipping cross-file analysis for PR#${context.pullRequest.number}: agents investigate cross-file via tools`,
            context: this.stageName,
        });
        return { suggestions: [] };

        try {
            const preparedFilesData = context.changedFiles.map((file) => ({
                filename: file.filename,
                patchWithLinesStr: file.patchWithLinesStr,
            }));

            const crossFileAnalysis =
                await this.crossFileAnalysisService.analyzeCrossFileCode(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    context,
                    preparedFilesData,
                    undefined,
                );

            const crossFileAnalysisSuggestions =
                crossFileAnalysis?.codeSuggestions || [];

            if (crossFileAnalysisSuggestions.length > 0) {
                this.logger.log({
                    message: `Cross-file analysis completed for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        suggestionsCount: crossFileAnalysisSuggestions.length,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });

                return { suggestions: crossFileAnalysisSuggestions };
            } else {
                this.logger.log({
                    message: `No cross-file analysis suggestions found for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return { suggestions: [] };
            }
        } catch (error) {
            this.logger.error({
                message: `Error during Cross-file analysis for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return {
                suggestions: [],
                error: {
                    stage: this.stageName,
                    substage: 'CrossFileAnalysis',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        prNumber: context.pullRequest.number,
                    },
                },
            };
        }
    }

    private async runBusinessLogicValidation(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!(await this.shouldRunBusinessLogicValidation(context))) {
            this.logger.log({
                message: `Skipping BusinessLogicValidation for PR#${context.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    status: 'skipped',
                },
            });
            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
            });
        }

        const prBody = context.pullRequest.body ?? '';
        const signalSources = this.buildSignalSources(context);
        const prBodyHash = this.computePrBodyHash(prBody);
        const signals = this.detectSignals(signalSources, prBody);

        try {
            const prepareContext = {
                userQuestion: '@kody -v business-logic',
                pullRequest: {
                    pullRequestNumber: context.pullRequest.number,
                    headRef: context.pullRequest?.head?.ref,
                    baseRef: context.pullRequest?.base?.ref,
                },
                repository: context.repository,
                pullRequestDescription: prBody,
                platformType: context.platformType,
                defaultBranch: context.pullRequest?.base?.ref,
                businessSignals: signals,
            };
            const thread = this.createBusinessLogicThread(context);

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('BusinessLogicValidation timeout')),
                    ProcessFilesPrLevelReviewStage.BUSINESS_LOGIC_TIMEOUT_MS,
                ),
            );

            const agentPromise =
                this.businessRulesValidationAgentProvider.execute({
                    organizationAndTeamData: context.organizationAndTeamData,
                    prepareContext,
                    thread,
                });

            const result = await Promise.race([agentPromise, timeoutPromise]);
            const hasGap = this.resultHasGap(result);

            if (!hasGap) {
                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [];
                    draft.businessLogicPrBodyHash = prBodyHash;
                });
            }

            const suggestion: ISuggestionByPR = {
                id: uuidv4(),
                suggestionContent: result,
                oneSentenceSummary:
                    'Business logic gap detected based on PR requirements.',
                label: LabelType.BUSINESS_LOGIC,
                severity: SeverityLevel.MEDIUM,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [suggestion];
                draft.businessLogicPrBodyHash = prBodyHash;
            });
        } catch (error) {
            const pipelineError: PipelineError = {
                stage: this.stageName,
                substage: 'BusinessRulesValidationAgent',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { prNumber: context.pullRequest.number },
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.errors.push(pipelineError);
            });
        }
    }

    private settledError(
        settled: PromiseRejectedResult,
        substage: string,
        context: CodeReviewPipelineContext,
    ): PipelineError {
        return {
            stage: this.stageName,
            substage,
            error:
                settled.reason instanceof Error
                    ? settled.reason
                    : new Error(String(settled.reason)),
            metadata: { prNumber: context.pullRequest.number },
        };
    }

    private async shouldRunBusinessLogicValidation(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        if (!context.codeReviewConfig?.reviewOptions?.business_logic) {
            return false;
        }

        const prBody = context.pullRequest?.body ?? '';
        const signalSources = this.buildSignalSources(context);
        if (!this.hasBusinessSignals(signalSources)) {
            return false;
        }

        const currentHash = this.computePrBodyHash(prBody);
        const lastHash = (context.pipelineMetadata?.lastExecution as any)
            ?.businessLogicHash;
        if (lastHash && lastHash === currentHash) {
            return false;
        }

        return true;
    }

    /**
     * Build the combined text surface (body + title + branch name) used for
     * ticket-key and task-link detection — mirrors the v4 stage so this
     * legacy path stays in sync.
     */
    private buildSignalSources(context: CodeReviewPipelineContext): string {
        const body = context.pullRequest?.body ?? '';
        const title = context.pullRequest?.title ?? '';
        const branch = context.pullRequest?.head?.ref ?? '';
        return [body, title, branch].filter(Boolean).join(' ');
    }

    private hasBusinessSignals(body: string): boolean {
        return (
            this.detectTicketKeys(body).length > 0 ||
            this.detectTaskLinks(body).length > 0
        );
    }

    /**
     * Ticket keys and task URLs may legitimately come from the PR title or
     * branch name. Requirement keywords (`when`, `then`, ...) stay scoped to
     * the body — they double as common English words that would false-positive
     * on titles like "Fix crash when user clicks save".
     */
    private detectSignals(
        combined: string,
        body: string,
    ): Record<string, string[]> {
        return {
            ticketKeys: this.detectTicketKeys(combined),
            taskLinks: this.detectTaskLinks(combined),
            requirementKeywords: this.detectRequirementKeywords(body),
        };
    }

    private detectTicketKeys(body: string): string[] {
        const matches = body.match(/[A-Za-z]{2,}-\d+/g) ?? [];
        return Array.from(new Set(matches.map((m) => m.toUpperCase())));
    }

    private detectTaskLinks(body: string): string[] {
        const matches = body.match(/https?:\/\/[^\s)>\]"']+/g);
        return matches ?? [];
    }

    private detectRequirementKeywords(body: string): string[] {
        const lower = body.toLowerCase();
        return ProcessFilesPrLevelReviewStage.REQUIREMENT_KEYWORDS.filter(
            (kw) => lower.includes(kw),
        );
    }

    private computePrBodyHash(body: string): string {
        return crypto.createHash('sha256').update(body).digest('hex');
    }

    private resultHasGap(result: string): boolean {
        if (!result || result.trim().length === 0) {
            return false;
        }

        const lower = result.toLowerCase();
        const limitationIndicators = [
            'need task information',
            'need pull request diff',
            'insufficient task context',
            'limited task context',
            'could not validate',
            'without the actual code changes, i can',
            'preciso do diff da pull request',
            'preciso de informacoes da task',
            'contexto insuficiente da task',
            'contexto limitado da task',
            'nao consegui validar',
            'sem as alteracoes de codigo',
            'mcp connection failed',
            'mcp integration required',
            'no compatible mcp integration',
        ];
        if (
            limitationIndicators.some((indicator) => lower.includes(indicator))
        ) {
            return false;
        }

        const noGapIndicators = [
            'no gaps',
            'no issues',
            'fully compliant',
            'no business logic gap',
            'all requirements met',
            'implementation is complete',
            'no violations',
            '✅ compliant',
            'status: ✅',
            'sem bloqueios identificados',
            'requirements covered',
            '"needsmoreinfo": false',
        ];
        return !noGapIndicators.some((indicator) => lower.includes(indicator));
    }

    private createBusinessLogicThread(context: CodeReviewPipelineContext) {
        try {
            const identifiers: Record<string, string | number> = {
                organizationId: context.organizationAndTeamData.organizationId,
                teamId: context.organizationAndTeamData.teamId,
                repositoryId: context.repository.id,
                pullRequestNumber: context.pullRequest.number,
            };

            if (context.userGitId) {
                identifiers.userId = context.userGitId;
            }

            return createThreadId(identifiers, { prefix: 'vbl' });
        } catch (error) {
            this.logger.warn({
                message: `Failed to create business logic thread for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
            });
            return undefined;
        }
    }
}
