import { UseCases } from '@/core/application/use-cases/pullRequests';
import { SavePullRequestUseCase } from '@/core/application/use-cases/pullRequests/save.use-case';
import { PULL_REQUESTS_REPOSITORY_TOKEN } from '@/core/domain/pullRequests/contracts/pullRequests.repository';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsRepository } from '@/core/infrastructure/adapters/repositories/mongoose/pullRequests.repository';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@/core/infrastructure/adapters/repositories/mongoose/schema/pullRequests.model';
import { PullRequestsService } from '@/core/infrastructure/adapters/services/pullRequests/pullRequests.service';
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { PullRequestController } from '@/core/infrastructure/http/controllers/pullRequest.controller';
import { CodebaseModule } from './codeBase.module';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: PullRequestsModel.name,
                schema: PullRequestsSchema,
            },
        ]),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => CodebaseModule),   
    ],
    providers: [
        ...UseCases,
        {
            provide: PULL_REQUESTS_REPOSITORY_TOKEN,
            useClass: PullRequestsRepository,
        },
        {
            provide: PULL_REQUESTS_SERVICE_TOKEN,
            useClass: PullRequestsService,
        },
    ],
    controllers: [PullRequestController],
    exports: [
        PULL_REQUESTS_REPOSITORY_TOKEN,
        PULL_REQUESTS_SERVICE_TOKEN,
        SavePullRequestUseCase,
    ],
})
export class PullRequestsModule {}
