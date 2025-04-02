/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { CodeSuggestion } from '@/config/types/general/codeReview.type';

export const KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN = Symbol(
    'KodyFineTuningContextPreparation',
);

export interface IKodyFineTuningContextPreparationService {
    /**
     * Performs fine tuning analysis on code suggestions
     * @param organizationId Organization identifier
     * @param prNumber Pull Request number
     * @param repository Repository information
     * @param suggestionsToAnalyze Suggestions to be analyzed
     * @param clusterizedSuggestions Clusterized suggestions
     * @param isFineTuningEnabled Whether fine tuning is enabled
     * @returns Array of analyzed suggestions
     */
    prepareKodyFineTuningContext(
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
