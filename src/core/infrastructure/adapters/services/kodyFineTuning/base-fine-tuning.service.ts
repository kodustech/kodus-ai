/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeSuggestion } from '@/config/types/general/codeReview.type';
import { IKodyFineTuningContextPreparationService } from '@/shared/interfaces/kody-fine-tuning-context-preparation.interface';
import { IClusterizedSuggestion } from '@/ee/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';

/**
 * Abstract base class for Kody fine tuning context preparation
 * Implements the Template Method pattern to define the overall preparation flow
 * and allow subclasses to customize specific behaviors
 */
@Injectable()
export abstract class BaseKodyFineTuningContextPreparation
    implements IKodyFineTuningContextPreparationService {
    constructor(protected readonly logger: PinoLoggerService) { }

    /**
     * Prepares the context for Kody fine tuning analysis
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param suggestionsToAnalyze Suggestions to be analyzed
     * @param clusterizedSuggestions Clusterized suggestions
     * @param isFineTuningEnabled Whether fine tuning is enabled
     * @returns Array of analyzed suggestions
     */
    async prepareKodyFineTuningContext(
        organizationId: string,
        prNumber: number,
        repository: {
            id: string;
            full_name: string;
        },
        suggestionsToAnalyze: CodeSuggestion[],
        isFineTuningEnabled: boolean,
    ): Promise<Partial<CodeSuggestion>[]> {
        try {
            return await this.prepareKodyFineTuningContextInternal(
                organizationId,
                prNumber,
                repository,
                suggestionsToAnalyze,
                isFineTuningEnabled,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error while preparing Kody fine tuning context',
                error,
                context: BaseKodyFineTuningContextPreparation.name,
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

    /**
     * Abstract method to prepare the Kody fine tuning context
     * Must be implemented by subclasses
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param suggestionsToAnalyze Suggestions to be analyzed
     * @param clusterizedSuggestions Clusterized suggestions
     * @param isFineTuningEnabled Whether fine tuning is enabled
     * @returns Prepared suggestions
     */
    protected abstract prepareKodyFineTuningContextInternal(
        organizationId: string,
        prNumber: number,
        repository: {
            id: string;
            full_name: string;
        },
        suggestionsToAnalyze: CodeSuggestion[],
        isFineTuningEnabled: boolean,
    ): Promise<Partial<CodeSuggestion>[]>;
}
