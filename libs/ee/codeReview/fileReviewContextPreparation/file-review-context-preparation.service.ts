import { createLogger } from '@kodus/flow';
/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';

import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';

import { BaseFileReviewContextPreparation } from '@libs/code-review/infrastructure/adapters/services/code-analysis/file/base-file-review.abstract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { ReviewModeOptions } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    AnalysisContext,
    FileChange,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
/**
 * Enterprise (cloud) implementation of the file review context preparation service
 * Extends the base class and overrides methods to add advanced functionalities
 * Available only in the cloud version or with an enterprise license
 */
@Injectable()
export class FileReviewContextPreparation extends BaseFileReviewContextPreparation {
    protected readonly logger = createLogger(FileReviewContextPreparation.name);
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,
    ) {
        super();
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
        byokConfig?: BYOKConfig,
    ): Promise<ReviewModeResponse> {
        return ReviewModeResponse.HEAVY_MODE;
    }

    /**
     * Overrides the method for preparing the internal context
     * @param file File to be analyzed
     * @param patchWithLinesStr Patch with line numbers
     * @param context Analysis context
     * @returns Prepared file context
     * @override
     */
    protected async prepareFileContextInternal(
        file: FileChange,
        patchWithLinesStr: string,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        const baseContext = await super.prepareFileContextInternal(
            file,
            patchWithLinesStr,
            context,
        );

        if (!baseContext) {
            return null;
        }

        const fileContext: AnalysisContext = {
            ...baseContext.fileContext,
            workflowJobId: context.workflowJobId, // Pass workflowJobId from pipeline context
        };

        return { fileContext };
    }

    private async getReviewMode(
        options: ReviewModeOptions,
        byokConfig: BYOKConfig,
    ): Promise<ReviewModeResponse> {
        return ReviewModeResponse.HEAVY_MODE;
    }

    protected async getRelevantFileContent(
        file: FileChange,
        context: AnalysisContext,
    ): Promise<{
        relevantContent: string | null;
        hasRelevantContent?: boolean;
    }> {
        try {
            // Use graph-formatted content when available (set by GraphContentFormatter)
            if (file.astFormattedContent) {
                return {
                    relevantContent: file.astFormattedContent,
                    hasRelevantContent: true,
                };
            }

            return {
                relevantContent: file.fileContent || file.content || null,
                hasRelevantContent: false,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving relevant file content',
                error,
                context: FileReviewContextPreparation.name,
                metadata: {
                    ...context?.organizationAndTeamData,
                    filename: file.filename,
                },
            });
            return {
                relevantContent: file.fileContent || file.content || null,
                hasRelevantContent: false,
            };
        }
    }
}
