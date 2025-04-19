import { Injectable, Inject } from '@nestjs/common';

import {
    AIAnalysisResult,
    AnalysisContext,
    FileChangeContext,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';

import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@/core/infrastructure/adapters/services/codeBase/llmAnalysis.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { KODY_RULES_ANALYSIS_SERVICE_TOKEN } from './kodyRulesAnalysis.service';

@Injectable()
export class CodeAnalysisOrchestrator {
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly standardLLMAnalysisService: IAIAnalysisService,

        @Inject(KODY_RULES_ANALYSIS_SERVICE_TOKEN)
        private readonly kodyRulesAnalysisService: IAIAnalysisService,

        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly codeASTAnalysisService: IASTAnalysisService,

        private readonly logger: PinoLoggerService,
    ) {}

    async executeStandardAnalysis(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        try {
            const result =
                await this.standardLLMAnalysisService.analyzeCodeWithAI(
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    reviewModeResponse,
                    context,
                );

            if (!result) {
                this.logger.log({
                    message: `Standard suggestions null for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        fileContext,
                    },
                });
            }

            if (result?.codeSuggestions?.length === 0) {
                this.logger.log({
                    message: `Standard suggestions empty for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        fileContext,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error executing standard analysis for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                context: CodeAnalysisOrchestrator.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    error,
                },
            });
            return null;
        }
    }

    async executeMultipleCategoriesAnalysis(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        try {
            const categoryResults =
                await this.standardLLMAnalysisService.specificCategoriesCodeReview(
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    reviewModeResponse,
                    context,
                );

            if (!categoryResults || categoryResults.length === 0) {
                this.logger.log({
                    message: `No category suggestions for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        fileContext,
                    },
                });
                return null;
            }

            const combinedResult = this.combineAnalysisResults(categoryResults);

            return combinedResult;
        } catch (error) {
            this.logger.error({
                message: `Error executing multiple categories analysis for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                context: CodeAnalysisOrchestrator.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    error,
                },
            });
            return null;
        }
    }

    private combineAnalysisResults(
        results: AIAnalysisResult[],
    ): AIAnalysisResult {
        if (!results || results.length === 0) {
            return null;
        }

        const baseResult = { ...results[0] };

        baseResult.codeSuggestions = results.reduce(
            (allSuggestions, result) => {
                if (
                    result &&
                    result.codeSuggestions &&
                    result.codeSuggestions.length > 0
                ) {
                    return [...allSuggestions, ...result.codeSuggestions];
                }
                return allSuggestions;
            },
            [],
        );

        return baseResult;
    }

    async executeKodyRulesAnalysis(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        context: AnalysisContext,
        standardSuggestions: AIAnalysisResult | null,
    ): Promise<AIAnalysisResult | null> {
        try {
            if (
                !this.shouldExecuteKodyRules(
                    context,
                    organizationAndTeamData,
                    prNumber,
                )
            ) {
                return null;
            }

            const result =
                await this.kodyRulesAnalysisService.analyzeCodeWithAI(
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    ReviewModeResponse.HEAVY_MODE,
                    context,
                    standardSuggestions,
                );

            if (!result) {
                this.logger.log({
                    message: `Kody rules suggestions null for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        fileContext,
                    },
                });
            }

            if (result?.codeSuggestions?.length === 0) {
                this.logger.log({
                    message: `Kody rules suggestions empty for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        fileContext,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error executing Kody rules analysis for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                context: CodeAnalysisOrchestrator.name,
                error: error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    error,
                },
            });
            return null;
        }
    }

    async executeASTAnalysis(
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        try {
            if (!context?.impactASTAnalysis?.functionsAffectResult?.length) {
                return null;
            }

            const result = await this.codeASTAnalysisService.analyzeASTWithAI(
                context,
                reviewModeResponse,
            );

            if (!result) {
                this.logger.log({
                    message: `AST Breaking Changes suggestions null for file: ${fileContext?.file?.filename} from PR#${context.pullRequest.number}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        fileContext,
                    },
                });
            }

            if (result?.codeSuggestions?.length === 0) {
                this.logger.log({
                    message: `AST Breaking Changes suggestions empty for file: ${fileContext?.file?.filename} from PR#${context.pullRequest.number}`,
                    context: CodeAnalysisOrchestrator.name,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        fileContext,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error executing AST Breaking Changes for file: ${fileContext?.file?.filename} from PR#${context.pullRequest.number}`,
                context: CodeAnalysisOrchestrator.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    fileContext,
                    error,
                },
            });
            return null;
        }
    }

    private shouldExecuteKodyRules(
        context: AnalysisContext,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): boolean {
        const hasRules = context.codeReviewConfig?.kodyRules?.length > 0;
        const isEnabled = context.codeReviewConfig?.reviewOptions?.kody_rules;

        if (!hasRules || !isEnabled) {
            this.logger.log({
                message: `Kody rules will not execute: ${!hasRules ? 'No rules found' : 'Feature disabled'} for PR#${prNumber}`,
                context: CodeAnalysisOrchestrator.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    hasRules,
                    isEnabled,
                },
            });
        }

        return hasRules && isEnabled;
    }
}
