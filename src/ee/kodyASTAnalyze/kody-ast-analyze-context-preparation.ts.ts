/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { BaseKodyASTAnalyzeContextPreparation } from '@/core/infrastructure/adapters/services/kodyASTAnalyze/base-ast-analyze.service';
import { CodeAnalysisOrchestrator } from '../codeBase/codeAnalysisOrchestrator.service';
import { AIAnalysisResult, AnalysisContext } from '@/config/types/general/codeReview.type';

/**
 * Enterprise implementation of AST analysis service
 * Extends the base class and adds advanced functionality
 * Available only in the cloud version or with an enterprise license
 */
@Injectable()
export class KodyASTAnalyzeContextPreparationServiceEE extends BaseKodyASTAnalyzeContextPreparation {

    constructor(
        private readonly codeAnalysisOrchestrator: CodeAnalysisOrchestrator,

        protected readonly logger: PinoLoggerService,
    ) {
        super(logger);
    }

    /**
     * Performs advanced AST analysis
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param files Files to analyze
     * @param clusterizedSuggestions Clusterized suggestions
     * @param isAstAnalysisEnabled Whether AST analysis is enabled
     * @returns Array of analyzed files
     * @override
     */
    async prepareKodyASTAnalyzeContextInternal(
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        const { organizationAndTeamData, pullRequest } = context;


        try {
            const kodyASTSuggestions = await this.codeAnalysisOrchestrator.executeASTAnalysis(
                context.fileChangeContext,
                context.reviewModeResponse,
                context,
            );

            return kodyASTSuggestions
                ? kodyASTSuggestions
                : null;
        } catch (error) {
            this.logger.error({
                message: 'Error performing AST analysis',
                error,
                context: KodyASTAnalyzeContextPreparationServiceEE.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.prNumber
                },
            });

            return null;
        }
    }
}
