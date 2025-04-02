import { forwardRef, Module } from '@nestjs/common';
import { FileReviewContextPreparation } from '@/core/infrastructure/adapters/services/fileReviewContextPreparation/file-review-context-preparation.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

import { CodebaseModule } from '@/modules/codeBase.module';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_PROVIDER } from '@/core/infrastructure/providers/kody-fine-tuning-context-preparation.provider.ee';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@/shared/interfaces/kody-fine-tuning-context-preparation.interface';
import { KodyFineTuningContextPreparationService } from '@/core/infrastructure/adapters/services/kodyFineTuning/kody-fine-tuning-context-preparation.service';

@Module({
    imports: [forwardRef(() => CodebaseModule)],
    providers: [
        KodyFineTuningContextPreparationService, // Core implementation
        PinoLoggerService,
        KODY_FINE_TUNING_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
        KodyFineTuningContextPreparationService,
    ],
})
export class KodyFineTuningContextModule { }
