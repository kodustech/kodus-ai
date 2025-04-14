/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
    AnalysisContext,
    FileChange,
    ReviewModeConfig,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';
import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { BaseFileReviewContextPreparation } from '@/core/infrastructure/adapters/services/fileReviewContextPreparation/base-file-review-context-preparation.service';
import { ReviewModeOptions } from '@/shared/interfaces/file-review-context-preparation.interface';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@/core/infrastructure/adapters/services/codeBase/llmAnalysis.service';

/**
 * Enterprise (cloud) implementation of the file review context preparation service
 * Extends the base class and overrides methods to add advanced functionalities
 * Available only in the cloud version or with an enterprise license
 */
@Injectable()
export class FileReviewContextPreparation extends BaseFileReviewContextPreparation {
    constructor(
        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly astService: IASTAnalysisService,

        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,

        protected readonly logger: PinoLoggerService,
    ) {
        super(logger);
    }

    /**
     * Overrides the method for determining the review mode to use advanced logic
     * @param file File to be analyzed
     * @param patch File patch
     * @param context Analysis context
     * @returns Determined review mode
     * @override
     */
    protected async determineReviewMode(
        options?: ReviewModeOptions,
    ): Promise<ReviewModeResponse> {
        try {
            const { context } = options;

            let reviewMode = ReviewModeResponse.HEAVY_MODE;

            const shouldCheckMode =
                context?.codeReviewConfig?.reviewModeConfig ===
                    ReviewModeConfig.LIGHT_MODE_FULL ||
                context?.codeReviewConfig?.reviewModeConfig ===
                    ReviewModeConfig.LIGHT_MODE_PARTIAL;

            if (shouldCheckMode) {
                reviewMode = await this.getReviewMode(options);
            }

            return reviewMode;
        } catch (error) {
            this.logger.warn({
                message:
                    'Error determining advanced review mode, falling back to basic mode',
                error,
                context: FileReviewContextPreparation.name,
            });

            // In case of an error, we call the parent class method (basic implementation)
            // However, since BaseFileReviewContextPreparation is now abstract, we need to implement a fallback here
            return ReviewModeResponse.HEAVY_MODE;
        }
    }

    /**
     * Overrides the method for preparing the internal context to add AST analysis
     * @param file File to be analyzed
     * @param patchWithLinesStr Patch with line numbers
     * @param reviewMode Determined review mode
     * @param context Analysis context
     * @returns Prepared file context with AST analysis
     * @override
     */
    protected async prepareFileContextInternal(
        file: FileChange,
        patchWithLinesStr,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        let reviewMode = ReviewModeResponse.HEAVY_MODE;

        const baseContext = await super.prepareFileContextInternal(
            file,
            patchWithLinesStr,
            context,
        );

        if (!baseContext) {
            return null;
        }

        let fileContext: AnalysisContext = baseContext.fileContext;

        // Check if we should execute the AST analysis
        const shouldRunAST =
            reviewMode === ReviewModeResponse.HEAVY_MODE &&
            !!context?.codeAnalysisAST?.baseCodeGraph?.cloneDir &&
            !!context?.codeAnalysisAST?.headCodeGraph?.cloneDir &&
            !!context?.codeAnalysisAST?.headCodeGraphEnriched &&
            (context.codeAnalysisAST.headCodeGraphEnriched.nodes.length > 0 ||
                context.codeAnalysisAST.headCodeGraphEnriched.relationships
                    .length > 0);

        if (shouldRunAST) {
            try {
                const functionsAffected =
                    await this.astService.analyzeCodeWithGraph(
                        patchWithLinesStr,
                        file.filename,
                        baseContext.fileContext.organizationAndTeamData,
                        baseContext.fileContext.pullRequest,
                        baseContext.fileContext.codeAnalysisAST,
                    );

                // Generate the impact analysis
                const impactAnalysis =
                    await this.astService.generateImpactAnalysis(
                        baseContext.fileContext.codeAnalysisAST,
                        functionsAffected,
                        baseContext.fileContext.organizationAndTeamData,
                        baseContext.fileContext.pullRequest,
                    );

                // Creates a new context by combining the fileContext with the AST analysis
                fileContext = {
                    ...fileContext,
                    impactASTAnalysis: impactAnalysis,
                };
            } catch (error) {
                this.logger.error({
                    message: 'Error executing advanced AST analysis',
                    error,
                    context: FileReviewContextPreparation.name,
                    metadata: {
                        ...context?.organizationAndTeamData,
                        filename: file.filename,
                    },
                });
            }
        }

        return { fileContext };
    }

    private async getReviewMode(
        options: ReviewModeOptions,
    ): Promise<ReviewModeResponse> {
        const response = await this.aiAnalysisService.selectReviewMode(
            options.context.organizationAndTeamData,
            options.context.pullRequest.number,
            LLMModelProvider.DEEPSEEK_V3,
            options.fileChangeContext.file,
            options.patch,
        );

        return response;
    }
}
