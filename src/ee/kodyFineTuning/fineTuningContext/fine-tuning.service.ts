/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { CodeSuggestion } from '@/config/types/general/codeReview.type';
import { CodeReviewPipelineContext } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';
import { BaseKodyFineTuningContextPreparation } from '@/core/infrastructure/adapters/services/kodyFineTuning/base-fine-tuning.service';
import { ISuggestionService, SUGGESTION_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';

/**
 * Enterprise implementation of fine tuning service
 * Extends the base class and adds advanced functionality
 * Available only in the cloud version or with an enterprise license
 */
@Injectable()
export class KodyFineTuningContextPreparationServiceEE extends BaseKodyFineTuningContextPreparation {
    private context: CodeReviewPipelineContext;

    constructor(
        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,
        private readonly kodyFineTuningService: KodyFineTuningService,
        protected readonly logger: PinoLoggerService,
    ) {
        super(logger);
    }

    /**
     * Performs advanced fine tuning analysis
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param suggestionsToAnalyze Suggestions to be analyzed
     * @param clusterizedSuggestions Clusterized suggestions
     * @param isFineTuningEnabled Whether fine tuning is enabled
     * @returns Array of analyzed suggestions
     * @override
     */
    async prepareKodyFineTuningContextInternal(
        organizationId: string,
        prNumber: number,
        repository: {
            id: string;
            full_name: string;
        },
        suggestionsToAnalyze: CodeSuggestion[],
        isFineTuningEnabled: boolean,
    ): Promise<Partial<CodeSuggestion>[]> {
        // Verifica se o fine tuning está habilitado
        if (!isFineTuningEnabled) {
            return [];
        }

        const mainClusterizedSuggestions = await this.kodyFineTuningService.startAnalysis(
            organizationId,
            repository,
            prNumber,
            suggestionsToAnalyze[0].language,
        );

        // Verifica se há clusterizedSuggestions
        if (!mainClusterizedSuggestions || mainClusterizedSuggestions.length === 0) {
            return [];
        }

        try {
            const clusteredSuggestions: Partial<CodeSuggestion>[] = [];

            const result = await this.kodyFineTuningService.fineTuningAnalysis(
                organizationId,
                prNumber,
                {
                    id: repository.id,
                    full_name: repository.full_name,
                    language: '', // Language is not used in this context
                },
                suggestionsToAnalyze,
                mainClusterizedSuggestions,
            );

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error performing fine tuning analysis',
                error,
                context: KodyFineTuningContextPreparationServiceEE.name,
                metadata: {
                    organizationId,
                    prNumber,
                    repository: {
                        id: repository.id,
                        full_name: repository.full_name,
                    },
                },
            });
            return suggestionsToAnalyze;
        }
    }
}
