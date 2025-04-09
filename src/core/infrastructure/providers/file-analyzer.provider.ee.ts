/**
 * @license
 * © Kodus Tech. All rights reserved.
 */
import { Provider } from '@nestjs/common';
import { PinoLoggerService } from '../adapters/services/logger/pino.service';
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@/shared/interfaces/file-review-context-preparation.interface';
import { FileReviewContextPreparation as CoreFileReviewContextPreparation } from '../adapters/services/fileReviewContextPreparation/file-review-context-preparation.service';
import { FileReviewContextPreparation as ProFileReviewContextPreparation } from '@/ee/codeReview/fileReviewContextPreparation/file-review-context-preparation.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '../adapters/services/codeBase/llmAnalysis.service';
import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { environment } from '@/ee/configs/environment';

export const FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER: Provider = {
    provide: FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    useFactory: (
        corePreparation: CoreFileReviewContextPreparation,
        PinoLoggerService: PinoLoggerService,
        aiAnalysisService: IAIAnalysisService,
        astAnalysisService: IASTAnalysisService,
    ): IFileReviewContextPreparation => {
        const isCloud = environment.API_CLOUD_MODE;

        if (isCloud) {
            return new ProFileReviewContextPreparation(
                astAnalysisService,
                aiAnalysisService,
                PinoLoggerService,
            );
        }

        return corePreparation;
    },
    inject: [
        CoreFileReviewContextPreparation,
        PinoLoggerService,
        LLM_ANALYSIS_SERVICE_TOKEN,
        AST_ANALYSIS_SERVICE_TOKEN,
    ],
};
