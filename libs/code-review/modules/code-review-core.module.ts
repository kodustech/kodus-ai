import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CodeReviewExecutionModel } from '@libs/automation/infrastructure/adapters/repositories/schemas/codeReviewExecution.model';
import { CODE_REVIEW_EXECUTION_SERVICE } from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import { CodeReviewExecutionService } from '@libs/automation/infrastructure/adapters/services/codeReviewExecution.service';
import { CODE_REVIEW_EXECUTION_REPOSITORY } from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.repository.contract';
import { CodeReviewExecutionRepository } from '@libs/automation/infrastructure/adapters/repositories/codeReviewExecution.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { PullRequestsRepository } from '@libs/platformData/infrastructure/adapters/repositories/pullRequests.repository';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsService } from '@libs/platformData/infrastructure/adapters/services/pullRequests.service';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case'; // Added
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module'; // Added
import { PrDecisionStoreService } from '@libs/code-review/infrastructure/adapters/services/pr-decision-store.service';
import { PR_DECISION_STORE_TOKEN } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { BuildPreviousReviewDecisionsUseCase } from '@libs/code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: PullRequestsModel.name,
                schema: PullRequestsSchema,
            },
        ]),
        TypeOrmModule.forFeature([CodeReviewExecutionModel]),
        forwardRef(() => PlatformModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => PlatformCoreModule), // Added
    ],
    providers: [
        {
            provide: CODE_REVIEW_EXECUTION_SERVICE,
            useClass: CodeReviewExecutionService,
        },
        {
            provide: CODE_REVIEW_EXECUTION_REPOSITORY,
            useClass: CodeReviewExecutionRepository,
        },
        {
            provide: PULL_REQUESTS_REPOSITORY_TOKEN,
            useClass: PullRequestsRepository,
        },
        {
            provide: PULL_REQUESTS_SERVICE_TOKEN,
            useClass: PullRequestsService,
        },
        SavePullRequestUseCase,
        BackfillHistoricalPRsUseCase, // Added
        {
            provide: PR_DECISION_STORE_TOKEN,
            useClass: PrDecisionStoreService,
        },
        BuildPreviousReviewDecisionsUseCase,
    ],
    exports: [
        CODE_REVIEW_EXECUTION_SERVICE,
        CODE_REVIEW_EXECUTION_REPOSITORY,
        PULL_REQUESTS_REPOSITORY_TOKEN,
        PULL_REQUESTS_SERVICE_TOKEN,
        SavePullRequestUseCase,
        BackfillHistoricalPRsUseCase, // Added
        BuildPreviousReviewDecisionsUseCase,
    ],
})
export class CodeReviewCoreModule {}
