import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
    PullRequestsModel,
    PullRequestsSchema,
} from './infrastructure/adapters/repositories/schemas/pullRequests.model';
import { PullRequestsRepository } from './infrastructure/adapters/repositories/pullRequests.repository';
import { PullRequestsService } from './infrastructure/adapters/services/pullRequests.service';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from './domain/pullRequests/contracts/pullRequests.repository';
import { PULL_REQUESTS_SERVICE_TOKEN } from './domain/pullRequests/contracts/pullRequests.service.contracts';
import { SavePullRequestUseCase } from './application/use-cases/pullRequests/save.use-case';
import { BackfillHistoricalPRsUseCase } from './application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import {
    CodeAreaRiskMapModel,
    CodeAreaRiskMapSchema,
} from './infrastructure/adapters/repositories/schemas/code-area-risk-map.model';
import { CodeAreaRiskMapService } from './infrastructure/adapters/services/code-area-risk-map.service';
import { RefreshCodeAreaRiskMapService } from './infrastructure/adapters/services/refresh-code-area-risk-map.service';
import {
    CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN,
} from './domain/code-area-risk/code-area-risk-map.contract';
import {
    CodeAreaHistoryPrModel,
    CodeAreaHistoryPrSchema,
    CodeAreaHistorySyncModel,
    CodeAreaHistorySyncSchema,
} from './infrastructure/adapters/repositories/schemas/code-area-history.model';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: PullRequestsModel.name,
                schema: PullRequestsSchema,
            },
            {
                name: CodeAreaRiskMapModel.name,
                schema: CodeAreaRiskMapSchema,
            },
            {
                name: CodeAreaHistoryPrModel.name,
                schema: CodeAreaHistoryPrSchema,
            },
            {
                name: CodeAreaHistorySyncModel.name,
                schema: CodeAreaHistorySyncSchema,
            },
        ]),
        forwardRef(() => PlatformModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PermissionsModule),
        forwardRef(() => PermissionValidationModule),
    ],
    providers: [
        {
            provide: PULL_REQUESTS_REPOSITORY_TOKEN,
            useClass: PullRequestsRepository,
        },
        {
            provide: PULL_REQUESTS_SERVICE_TOKEN,
            useClass: PullRequestsService,
        },
        SavePullRequestUseCase,
        BackfillHistoricalPRsUseCase,
        {
            provide: CODE_AREA_RISK_MAP_SERVICE_TOKEN,
            useClass: CodeAreaRiskMapService,
        },
        {
            provide: REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN,
            useClass: RefreshCodeAreaRiskMapService,
        },
    ],
    exports: [
        PULL_REQUESTS_REPOSITORY_TOKEN,
        PULL_REQUESTS_SERVICE_TOKEN,
        SavePullRequestUseCase,
        BackfillHistoricalPRsUseCase,
        CODE_AREA_RISK_MAP_SERVICE_TOKEN,
        REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    ],
})
export class PlatformDataModule {}
