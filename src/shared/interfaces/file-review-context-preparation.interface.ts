/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import {
    AnalysisContext,
    FileChange,
    FileChangeContext,
} from '@/config/types/general/codeReview.type';

export const FILE_REVIEW_CONTEXT_PREPARATION_TOKEN = Symbol(
    'FileReviewContextPreparation',
);

export interface ReviewModeOptions {
    fileChangeContext?: FileChangeContext;
    patch?: string;
    context?: AnalysisContext;
}

export interface IFileReviewContextPreparation {
    prepareFileContext(
        file: FileChange,
        context: AnalysisContext,
    ): Promise<{ fileContext: AnalysisContext } | null>;
}
