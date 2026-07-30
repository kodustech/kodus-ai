import { Module, forwardRef } from '@nestjs/common';
import { GetEnrichedPullRequestsUseCase } from '../application/use-cases/dashboard/get-enriched-pull-requests.use-case';
import { GetPullRequestsDailyDigestUseCase } from '../application/use-cases/dashboard/get-pull-requests-daily-digest.use-case';
import { GetPullRequestsFacetsUseCase } from '../application/use-cases/dashboard/get-pull-requests-facets.use-case';
import { GetAwaitingPullRequestsUseCase } from '../application/use-cases/dashboard/get-awaiting-pull-requests.use-case';
import { GetPullRequestAuthorsUseCase } from '../application/use-cases/dashboard/get-pull-request-authors.use-case';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { PlatformDataModule } from '@libs/platformData/platformData.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { CodeReviewExecutionModule } from '@libs/code-review/modules/codeReviewExecution.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';

@Module({
    imports: [
        forwardRef(() => AutomationModule),
        forwardRef(() => PlatformDataModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => PermissionsModule),
        forwardRef(() => CodeReviewExecutionModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        GetEnrichedPullRequestsUseCase,
        GetPullRequestsDailyDigestUseCase,
        GetPullRequestsFacetsUseCase,
        GetAwaitingPullRequestsUseCase,
        GetPullRequestAuthorsUseCase,
    ],
    exports: [
        GetEnrichedPullRequestsUseCase,
        GetPullRequestsDailyDigestUseCase,
        GetPullRequestsFacetsUseCase,
        GetAwaitingPullRequestsUseCase,
        GetPullRequestAuthorsUseCase,
    ],
})
export class CodeReviewDashboardModule {}
