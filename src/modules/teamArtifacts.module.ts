import { TEAM_ARTIFACTS_REPOSITORY_TOKEN } from '@/core/domain/teamArtifacts/contracts/teamArtifacts.repository';
import { TEAM_ARTIFACTS_SERVICE_TOKEN } from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { TeamArtifactsModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { TeamArtifactsDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/teamArtifacts.repository';
import { TeamArtifactsService } from '@/core/infrastructure/adapters/services/teamArtifacts/teamArtifacts.service';
import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { TeamMembersModule } from './teamMembers.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { TeamArtifactsController } from '@/core/infrastructure/http/controllers/teamArtifacts.controller';
import { UseCases } from '@/core/application/use-cases/teamArtifacts';
import { MetricsModule } from './metrics.module';
import { LogModule } from './log.module';
import { ParametersModule } from './parameters.module';
import { ExecuteTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts/execute-teamArtifacts';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { TeamsModule } from './team.module';
import { EnrichTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts/enrich-team-artifacts.use-case';

@Module({
    imports: [
        MongooseModule.forFeature([TeamArtifactsModelInstance]),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => LogModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => TeamsModule),
    ],
    providers: [
        ...UseCases,
        EnrichTeamArtifactsUseCase,
        ExecuteTeamArtifactsUseCase,
        PromptService,
        {
            provide: TEAM_ARTIFACTS_SERVICE_TOKEN,
            useClass: TeamArtifactsService,
        },
        {
            provide: TEAM_ARTIFACTS_REPOSITORY_TOKEN,
            useClass: TeamArtifactsDatabaseRepository,
        },
    ],
    controllers: [TeamArtifactsController],
    exports: [
        TEAM_ARTIFACTS_SERVICE_TOKEN,
        TEAM_ARTIFACTS_REPOSITORY_TOKEN,
        ExecuteTeamArtifactsUseCase,
        EnrichTeamArtifactsUseCase,
    ],
})
export class TeamArtifactsModule {}
