/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';
import { clone } from 'ramda';
import {
    IFileReviewContextPreparation,
    ReviewModeOptions,
} from '@/shared/interfaces/file-review-context-preparation.interface';
import {
    AnalysisContext,
    FileChange,
    FileChangeContext,
    ReviewModeConfig,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';
import { PinoLoggerService } from '../logger/pino.service';
import { benchmark } from '@/shared/utils/benchmark.util';
import {
    convertToHunksWithLinesNumbers,
    handlePatchDeletions,
} from '@/shared/utils/patch';

/**
 * Abstract base class for file review context preparation
 * Implements the Template Method pattern to define the overall preparation flow
 * and allow subclasses to customize specific behaviors
 */
@Injectable()
export abstract class BaseFileReviewContextPreparation
    implements IFileReviewContextPreparation
{
    constructor(protected readonly logger: PinoLoggerService) {}

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

            const patchFormatted = handlePatchDeletions(
                file.patch,
                file.filename,
                file.status,
            );
            if (!patchFormatted) {
                return null;
            }

            const patchWithLinesStr = convertToHunksWithLinesNumbers(
                patchFormatted,
                file,
            );

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
        patchWithLinesStr,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null> {
        const reviewMode = await this.determineReviewMode(
            {
                fileChangeContext: {
                    file,
                },
                patch: patchWithLinesStr,
                context,
            },
        );

        const updatedContext: AnalysisContext = {
            ...context,
            reviewModeResponse: reviewMode,
            fileChangeContext: {
                file,
                patchWithLinesStr,
            },
        };

        return { fileContext: updatedContext };
    }
}
