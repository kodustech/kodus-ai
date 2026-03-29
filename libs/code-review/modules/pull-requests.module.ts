import { Module, forwardRef } from '@nestjs/common';

import { CodebaseModule } from '@libs/code-review/modules/codebase.module'; // Will be CodebaseCoreModule later
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { CodeReviewCoreModule } from './code-review-core.module';
import { GetPullRequestSuggestionsUseCase } from '../application/use-cases/pullRequests/get-pull-request-suggestions.use-case';

@Module({
    imports: [
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => CodebaseModule), // Should point to Core when ready
        CodeReviewCoreModule,
    ],
    providers: [GetPullRequestSuggestionsUseCase],
    exports: [CodeReviewCoreModule, GetPullRequestSuggestionsUseCase],
})
export class PullRequestsModule {}
