/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';
import { BaseKodyFineTuningContextPreparation } from './base-fine-tuning.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeSuggestion } from '@/config/types/general/codeReview.type';

/**
 * Core implementation of Kody fine tuning context preparation
 * Provides minimal functionality for preparing Kody fine tuning context
 */
@Injectable()
export class KodyFineTuningContextPreparationService extends BaseKodyFineTuningContextPreparation {
    constructor(protected readonly logger: PinoLoggerService) {
        super(logger);
    }

    protected async prepareKodyFineTuningContextInternal(
        organizationId: string,
        prNumber: number,
        repository: {
            id: string;
            full_name: string;
        },
        suggestionsToAnalyze: CodeSuggestion[],
        isFineTuningEnabled: boolean,
    ): Promise<{
        keepedSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestions: Partial<CodeSuggestion>[];
    }> {
        return {
            keepedSuggestions: [],
            discardedSuggestions: [],
        };
    }
}
