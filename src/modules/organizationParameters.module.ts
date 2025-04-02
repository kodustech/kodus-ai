import { ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN } from '@/core/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organizationParameters.repository';
import { OrganizationParametersModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationParameters.model';
import { OrganizationParametersService } from '@/core/infrastructure/adapters/services/organizationParameters.service';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JiraModule } from './jira.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { TeamsModule } from './team.module';
import { SaveCategoryWorkItemsTypesUseCase } from '@/core/application/use-cases/organizationParameters/save-category-workitems-types.use-case';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PlatformIntegrationFactory } from '@/core/infrastructure/adapters/services/platformIntegration/platformIntegration.factory';
import { ParametersModule } from './parameters.module';
import { OrgnizationParametersController } from '@/core/infrastructure/http/controllers/organizationParameters.controller';
import { CreateOrUpdateOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/create-or-update.use-case';
import { FindByKeyOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/find-by-key.use-case';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationParametersModel]),
        forwardRef(() => JiraModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => ParametersModule),
    ],
    providers: [
        SaveCategoryWorkItemsTypesUseCase,
        CreateOrUpdateOrganizationParametersUseCase,
        FindByKeyOrganizationParametersUseCase,
        OrganizationParametersService,
        PromptService,
        ProjectManagementService,
        PlatformIntegrationFactory,
        {
            provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
            useClass: OrganizationParametersService,
        },
        {
            provide: ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
            useClass: OrganizationParametersRepository,
        },
    ],
    controllers: [OrgnizationParametersController],
    exports: [
        ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
        ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
        SaveCategoryWorkItemsTypesUseCase,
        OrganizationParametersService,
    ],
})
export class OrganizationParametersModule {}
