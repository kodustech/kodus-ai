import { Module, forwardRef } from '@nestjs/common';

import { CodebaseModule } from '@libs/code-review/modules/codebase.module'; // Will be CodebaseCoreModule later
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { CodeReviewCoreModule } from './code-review-core.module';
import { GetPullRequestFilesUseCase } from '../application/use-cases/pullRequests/get-pull-request-files.use-case';
import { GetPullRequestSuggestionsUseCase } from '../application/use-cases/pullRequests/get-pull-request-suggestions.use-case';
import { FindTeamKeyPullRequestUseCase } from '../application/use-cases/pullRequests/find-team-key-pull-request.use-case';

@Module({
    imports: [
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => CodebaseModule), // Should point to Core when ready
        CodeReviewCoreModule,
    ],
    providers: [
        GetPullRequestSuggestionsUseCase,
        GetPullRequestFilesUseCase,
        FindTeamKeyPullRequestUseCase,
    ],
    exports: [
        CodeReviewCoreModule,
        GetPullRequestSuggestionsUseCase,
        GetPullRequestFilesUseCase,
        FindTeamKeyPullRequestUseCase,
    ],
})
export class PullRequestsModule {}
