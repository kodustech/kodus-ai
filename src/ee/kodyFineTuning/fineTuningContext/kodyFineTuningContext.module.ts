import { forwardRef, Module } from '@nestjs/common';

import { CodebaseModule } from '@/modules/codeBase.module';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_PROVIDER } from '@/core/infrastructure/providers/kody-fine-tuning-context-preparation.provider.ee';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@/shared/interfaces/kody-fine-tuning-context-preparation.interface';
import { KodyFineTuningContextPreparationService } from '@/core/infrastructure/adapters/services/kodyFineTuning/kody-fine-tuning-context-preparation.service';
import { LogModule } from '@/modules/log.module';

@Module({
    imports: [forwardRef(() => CodebaseModule), LogModule],
    providers: [
        KodyFineTuningContextPreparationService, // Core implementation
        KODY_FINE_TUNING_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
        KodyFineTuningContextPreparationService,
    ],
})
export class KodyFineTuningContextModule {}
