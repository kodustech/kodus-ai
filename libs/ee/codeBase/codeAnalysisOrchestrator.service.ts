import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';

import { LLM_ANALYSIS_SERVICE_TOKEN } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';
import {
    AIAnalysisResult,
    AnalysisContext,
    FileChangeContext,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { KODY_RULES_ANALYSIS_SERVICE_TOKEN } from './kodyRulesAnalysis.service';

@Injectable()
export class CodeAnalysisOrchestrator {
    private readonly logger = createLogger(CodeAnalysisOrchestrator.name);
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly standardLLMAnalysisService: IAIAnalysisService,
        @Inject(KODY_RULES_ANALYSIS_SERVICE_TOKEN)
        private readonly kodyRulesAnalysisService: IAIAnalysisService,
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
                await this.standardLLMAnalysisService.analyzeCodeWithAI_v2(
                    organizationAndTeamData,
                    prNumber,
                    fileContext,
                    reviewModeResponse,
                    context,
                    context.codeReviewConfig?.byokConfig,
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
            throw error;
        }
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

    private shouldExecuteKodyRules(
        context: AnalysisContext,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): boolean {
        const hasRules = context.codeReviewConfig?.kodyRules?.length > 0;

        if (!hasRules) {
            this.logger.log({
                message: `Kody rules will not execute: ${!hasRules ? 'No rules found' : 'Feature disabled'} for PR#${prNumber}`,
                context: CodeAnalysisOrchestrator.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    hasRules,
                    rulesCount:
                        context.codeReviewConfig?.kodyRules?.length || 0,
                    reviewOptions: context.codeReviewConfig?.reviewOptions,
                },
            });
        }

        return hasRules;
    }
}
