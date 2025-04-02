/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IKodyASTAnalyzeContextPreparationService } from '@/shared/interfaces/kody-ast-analyze-context-preparation.interface';
import { AIAnalysisResult, AnalysisContext, FileChange } from '@/config/types/general/codeReview.type';

/**
 * Abstract base class for Kody AST analysis context preparation
 * Implements the Template Method pattern to define the overall preparation flow
 * and allow subclasses to customize specific behaviors
 */
@Injectable()
export abstract class BaseKodyASTAnalyzeContextPreparation implements IKodyASTAnalyzeContextPreparationService {
    constructor(protected readonly logger: PinoLoggerService) { }

    async prepareKodyASTAnalyzeContext(
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        const { organizationAndTeamData, pullRequest } = context;

        try {
            return await this.prepareKodyASTAnalyzeContextInternal(
                context,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error while preparing Kody AST analysis context',
                error,
                context: BaseKodyASTAnalyzeContextPreparation.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.prNumber
                },
            });

            return null;
        }
    }

    /**
     * Abstract method to prepare the Kody AST analysis context
     * Must be implemented by subclasses
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param files Files to analyze
     * @param clusterizedSuggestions Clusterized suggestions
     * @returns Prepared files
     */
    protected abstract prepareKodyASTAnalyzeContextInternal(
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null>
}
