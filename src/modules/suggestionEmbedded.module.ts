import { SuggestionEmbeddedModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/suggestionEmbedded.model';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { PullRequestsModule } from './pullRequests.module';
import { SuggestionEmbeddedController } from '@/core/infrastructure/http/controllers/suggestionEmbedded.controller';
import { GlobalParametersModule } from './global-parameters.module';
import { SuggestionEmbeddedDatabaseRepository } from '@/ee/kodyFineTuning/suggestionEmbedded.repository';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { SuggestionEmbeddedService } from '@/ee/kodyFineTuning/suggestionEmbedded/suggestionEmbedded.service';
import { SUGGESTION_EMBEDDED_REPOSITORY_TOKEN } from '@/ee/kodyFineTuning/domain/suggestionEmbedded/contracts/suggestionEmbedded.repository.contract';
import { SUGGESTION_EMBEDDED_SERVICE_TOKEN } from '@/ee/kodyFineTuning/domain/suggestionEmbedded/contracts/suggestionEmbedded.service.contract';
import { LogModule } from './log.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([SuggestionEmbeddedModel]),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => GlobalParametersModule),
        LogModule,
    ],
    providers: [
        SuggestionEmbeddedDatabaseRepository,
        KodyFineTuningService,
        SuggestionEmbeddedService,
        {
            provide: SUGGESTION_EMBEDDED_REPOSITORY_TOKEN,
            useClass: SuggestionEmbeddedDatabaseRepository,
        },
        {
            provide: SUGGESTION_EMBEDDED_SERVICE_TOKEN,
            useClass: SuggestionEmbeddedService,
        },
    ],
    exports: [
        SUGGESTION_EMBEDDED_REPOSITORY_TOKEN,
        SUGGESTION_EMBEDDED_SERVICE_TOKEN,
    ],
    controllers: [SuggestionEmbeddedController],
})
export class SuggestionEmbeddedModule {}
