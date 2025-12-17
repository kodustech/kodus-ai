import { UseCases } from '@/core/application/use-cases/parameters';
import { CreateOrUpdateParametersUseCase } from '@/core/application/use-cases/parameters/create-or-update-use-case';
import { PARAMETERS_REPOSITORY_TOKEN } from '@/core/domain/parameters/contracts/parameters.repository.contracts';
import { PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersRepository } from '@/core/infrastructure/adapters/repositories/typeorm/parameters.repository';
import { ParametersModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/parameters.model';
import { ParametersService } from '@/core/infrastructure/adapters/services/parameters.service';
import { ParametersController } from '@/core/infrastructure/http/controllers/parameters.controller';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationConfigModule } from './integrationConfig.module';
import { CodebaseModule } from './codeBase.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationModule } from './integration.module';
import { CodeReviewSettingsLogModule } from './codeReviewSettingsLog.module';
import { PullRequestMessagesModule } from './pullRequestMessages.module';
import { KodyRulesModule } from './kodyRules.module';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/update-or-create-code-review-parameter-use-case';
import { PromptsModule } from './prompts.module';
import { ContextReferenceModule } from './contextReference.module';
import { OrganizationParametersModule } from './organizationParameters.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([ParametersModel]),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => CodeReviewSettingsLogModule),
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => PromptsModule),
        forwardRef(() => ContextReferenceModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        ...UseCases,
        CreateOrUpdateParametersUseCase,
        {
            provide: PARAMETERS_SERVICE_TOKEN,
            useClass: ParametersService,
        },
        {
            provide: PARAMETERS_REPOSITORY_TOKEN,
            useClass: ParametersRepository,
        },
    ],
    controllers: [ParametersController],
    exports: [
        PARAMETERS_SERVICE_TOKEN,
        PARAMETERS_REPOSITORY_TOKEN,
        CreateOrUpdateParametersUseCase,
        UpdateOrCreateCodeReviewParameterUseCase,
    ],
})
export class ParametersModule {}
