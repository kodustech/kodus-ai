import { SaveFlowMetricsToDbUseCase } from '@/core/application/use-cases/metrics/save-db-flow-metrics.use-case';
import { ExecuteOrganizationArtifactsUseCase } from '@/core/application/use-cases/organizationArtifacts/execute-organization-artifacts.use-case';
import { SaveOrganizationMetricsToDbUseCase } from '@/core/application/use-cases/organizationMetrics/save-metrics.use-case';
import { UseCases } from '@/core/application/use-cases/team';
import { CreateTeamUseCase } from '@/core/application/use-cases/team/create.use-case';
import { ExecuteTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts/execute-teamArtifacts';
import { TEAM_REPOSITORY_TOKEN } from '@/core/domain/team/contracts/team.repository.contract';
import { TEAM_SERVICE_TOKEN } from '@/core/domain/team/contracts/team.service.contract';
import { TeamModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/team.model';
import { TeamDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/team.repository';
import { TeamService } from '@/core/infrastructure/adapters/services/team.service';
import { TeamController } from '@/core/infrastructure/http/controllers/team.controller';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileConfigModule } from './profileConfig.module';
import { UsersModule } from './user.module';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { MetricsModule } from './metrics.module';
import { SaveCategoryWorkItemsTypesUseCase } from '@/core/application/use-cases/organizationParameters/save-category-workitems-types.use-case';
import { OrganizationParametersModule } from './organizationParameters.module';
import { OrganizationParametersService } from '@/core/infrastructure/adapters/services/organizationParameters.service';
import { JiraModule } from './jira.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { CreateOrUpdateParametersUseCase } from '@/core/application/use-cases/parameters/create-or-update-use-case';
import { ParametersModule } from './parameters.module';
import { SaveAllTeamMetricsHistoryUseCase } from '@/core/application/use-cases/metrics/save-all-metrics-history.use-case';
import { SaveAllOrganizationMetricsHistoryUseCase } from '@/core/application/use-cases/organizationMetrics/save-metrics-history.use-case';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PlatformIntegrationFactory } from '@/core/infrastructure/adapters/services/platformIntegration/platformIntegration.factory';
import { IntegrationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/integration.model';
import { TeamArtifactsModule } from './teamArtifacts.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([TeamModel, IntegrationModel]),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => UsersModule),
        forwardRef(() => OrganizationArtifactsModule),
        forwardRef(() => OrganizationMetricsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => JiraModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        TeamArtifactsModule,
    ],
    providers: [
        ...UseCases,
        SaveCategoryWorkItemsTypesUseCase,
        ExecuteTeamArtifactsUseCase,
        ExecuteOrganizationArtifactsUseCase,
        SaveFlowMetricsToDbUseCase,
        SaveAllTeamMetricsHistoryUseCase,
        SaveAllOrganizationMetricsHistoryUseCase,
        SaveOrganizationMetricsToDbUseCase,
        CreateOrUpdateParametersUseCase,
        OrganizationParametersService,
        ProjectManagementService,
        PlatformIntegrationFactory,
        PromptService,
        TeamService,
        {
            provide: TEAM_SERVICE_TOKEN,
            useClass: TeamService,
        },
        {
            provide: TEAM_REPOSITORY_TOKEN,
            useClass: TeamDatabaseRepository,
        },
    ],
    exports: [TEAM_SERVICE_TOKEN, TEAM_REPOSITORY_TOKEN, CreateTeamUseCase],
    controllers: [TeamController],
})
export class TeamsModule {}
