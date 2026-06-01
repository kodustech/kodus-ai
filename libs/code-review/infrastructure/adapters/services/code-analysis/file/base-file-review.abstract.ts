import { createLogger } from '@kodus/flow';
/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import {
    IFileReviewContextPreparation,
    ReviewModeOptions,
} from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    AnalysisContext,
    FileChange,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    convertToUnifiedDiffWithLineNumbers,
    handlePatchDeletions,
} from '@libs/common/utils/patch';
/**
 * Abstract base class for file review context preparation
 * Implements the Template Method pattern to define the overall preparation flow
 * and allow subclasses to customize specific behaviors
 */
@Injectable()
export abstract class BaseFileReviewContextPreparation implements IFileReviewContextPreparation {
    protected readonly logger = createLogger(
        BaseFileReviewContextPreparation.name,
    );
    constructor() {}

    /**
     * Prepares the context for analyzing a file
     * @param file File to be analyzed
     * @param context Analysis context
     * @returns Prepared file context or null if the file does not have a patch
     */
    async prepareFileContext(
        file: FileChange,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        try {
            if (!file?.patch) {
                return null;
            }

            let patchWithLinesStr = file?.patchWithLinesStr || '';

            if (!patchWithLinesStr) {
                const patchFormatted = handlePatchDeletions(
                    file.patch,
                    file.filename,
                    file.status,
                );
                if (!patchFormatted) {
                    return null;
                }

                patchWithLinesStr = convertToUnifiedDiffWithLineNumbers(
                    patchFormatted,
                    file,
                );
            }

            return await this.prepareFileContextInternal(
                file,
                patchWithLinesStr,
                context,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error while preparing file context',
                error,
                context: BaseFileReviewContextPreparation.name,
                metadata: {
                    ...context?.organizationAndTeamData,
                    pullRequestNumber: context.pullRequest.number,
                },
            });
            return null;
        }
    }

    /**
     * Abstract method to determine the review mode
     * Must be implemented by subclasses
     * @param file File to be analyzed
     * @param patch File patch
     * @param context Analysis context
     * @returns Determined review mode
     */
    protected abstract determineReviewMode(
        options?: ReviewModeOptions,
        byokConfig?: BYOKConfig,
    ): Promise<ReviewModeResponse>;

    /**
     * Prepares the internal file context
     * Can be overridden by subclasses to add specific behaviors
     * @param file File to be analyzed
     * @param patchWithLinesStr Patch with line numbers
     * @param reviewMode Determined review mode
     * @param context Analysis context
     * @returns Prepared file context
     */
    protected async prepareFileContextInternal(
        file: FileChange,
        patchWithLinesStr: string,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        const reviewModeProm = this.determineReviewMode(
            {
                fileChangeContext: {
                    file,
                },
                patch: patchWithLinesStr,
                context,
            },
            context?.codeReviewConfig?.byokConfig,
        );

        const relevantContentProm = this.getRelevantFileContent(file, context);

        const [
            reviewModeResponse,
            { relevantContent, hasRelevantContent },
        ] = await Promise.all([reviewModeProm, relevantContentProm]);

        const updatedContext: AnalysisContext = {
            ...context,
            reviewModeResponse,
            fileChangeContext: {
                file,
                relevantContent,
                patchWithLinesStr,
                hasRelevantContent,
            },
        };

        return { fileContext: updatedContext };
    }

    protected abstract getRelevantFileContent(
        file: FileChange,
        context: AnalysisContext,
    ): Promise<{
        relevantContent: string | null;
        hasRelevantContent?: boolean;
    }>;
}
