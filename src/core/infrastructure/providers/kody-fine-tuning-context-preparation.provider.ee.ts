/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { KodyFineTuningContextPreparationService } from '../adapters/services/kodyFineTuning/kody-fine-tuning-context-preparation.service';
import { Provider } from '@nestjs/common';
import { PinoLoggerService } from '../adapters/services/logger/pino.service';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { KodyFineTuningContextPreparationServiceEE } from '@/ee/kodyFineTuning/fineTuningContext/fine-tuning.service';
import {
    IKodyFineTuningContextPreparationService,
    KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
} from '@/shared/interfaces/kody-fine-tuning-context-preparation.interface';
import { ISuggestionService } from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import { environment } from '@/ee/configs/environment';

export const KODY_FINE_TUNING_CONTEXT_PREPARATION_PROVIDER: Provider = {
    provide: KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
    useFactory: (
        corePreparation: KodyFineTuningContextPreparationService,
        kodyFineTuningService: KodyFineTuningService,
        pinoLoggerService: PinoLoggerService,
        suggestionService: ISuggestionService,
    ): IKodyFineTuningContextPreparationService => {
        const isCloud = environment.API_CLOUD_MODE;

        if (isCloud) {
            return new KodyFineTuningContextPreparationServiceEE(
                suggestionService,
                kodyFineTuningService,
                pinoLoggerService,
            );
        }

        return corePreparation;
    },
    inject: [
        KodyFineTuningContextPreparationService,
        KodyFineTuningService,
        PinoLoggerService,
    ],
};
