import { ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN } from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.repository';
import { ORGANIZATION_ARTIFACTS_SERVICE_TOKEN } from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';
import { OrganizationArtifactsDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/organizationArtifacts.repository';
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LogModule } from './log.module';
import { OrganizationArtifactsService } from '@/core/infrastructure/adapters/services/organizationArtifacts/organizationArtifacts.service';
import { OrganizationArtifactsModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { ParametersModule } from './parameters.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { UseCases } from '@/core/application/use-cases/organizationArtifacts';
import { OrganizationArtifactsController } from '@/core/infrastructure/http/controllers/organizationArtifacts.controller';
import { TeamMembersModule } from './teamMembers.module';
import { MetricsModule } from './metrics.module';
import { TeamsModule } from './team.module';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { SprintModule } from './sprint.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ExecuteOrganizationArtifactsUseCase } from '@/core/application/use-cases/organizationArtifacts/execute-organization-artifacts.use-case';

@Module({
    imports: [
        MongooseModule.forFeature([OrganizationArtifactsModelInstance]),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => LogModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => TeamArtifactsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => SprintModule),
    ],
    providers: [
        ...UseCases,
        ExecuteOrganizationArtifactsUseCase,
        PromptService,
        {
            provide: ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
            useClass: OrganizationArtifactsService,
        },
        {
            provide: ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN,
            useClass: OrganizationArtifactsDatabaseRepository,
        },
    ],
    controllers: [OrganizationArtifactsController],
    exports: [
        ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
        ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN,
        ExecuteOrganizationArtifactsUseCase,
    ],
})
export class OrganizationArtifactsModule {}
