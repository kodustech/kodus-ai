import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ContextResolutionModule } from '@libs/core/context-resolution/context-resolution.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { CreateOrUpdatePullRequestMessagesUseCase } from '../application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import { DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase } from '../application/use-cases/pullRequestMessages/delete-by-repository-or-directory.use-case';
import { FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase } from '../application/use-cases/pullRequestMessages/find-by-repo-or-directory.use-case';
import { FindOverrideCountsByRepositoryPullRequestMessagesUseCase } from '../application/use-cases/pullRequestMessages/find-override-counts-by-repository.use-case';
import { PULL_REQUEST_MESSAGES_REPOSITORY_TOKEN } from '../domain/pullRequestMessages/contracts/pullRequestMessages.repository.contract';
import { PULL_REQUEST_MESSAGES_SERVICE_TOKEN } from '../domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { PullRequestMessagesRepository } from '../infrastructure/adapters/repositories/pullRequestMessages.repository';
import { PullRequestMessagesModelInstance } from '../infrastructure/adapters/repositories/schemas/mongoose/pullRequestMessages.model';
import { PullRequestMessagesService } from '../infrastructure/adapters/services/pullRequestMessages.service';
import { CentralizedConfigModule } from '@libs/centralized-config/modules/centralized-config.module';

@Module({
    imports: [
        MongooseModule.forFeature([PullRequestMessagesModelInstance]),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PermissionsModule),
        forwardRef(() => ContextResolutionModule),
        forwardRef(() => CentralizedConfigModule),
    ],
    providers: [
        CreateOrUpdatePullRequestMessagesUseCase,
        FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase,
        FindOverrideCountsByRepositoryPullRequestMessagesUseCase,
        DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase,
        {
            provide: PULL_REQUEST_MESSAGES_REPOSITORY_TOKEN,
            useClass: PullRequestMessagesRepository,
        },
        {
            provide: PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
            useClass: PullRequestMessagesService,
        },
    ],
    exports: [
        PULL_REQUEST_MESSAGES_REPOSITORY_TOKEN,
        PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
        DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase,
        CreateOrUpdatePullRequestMessagesUseCase,
        FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase,
        FindOverrideCountsByRepositoryPullRequestMessagesUseCase,
    ],
})
export class PullRequestMessagesModule {}
