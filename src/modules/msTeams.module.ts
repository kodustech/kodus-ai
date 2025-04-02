import { MSTEAMS_SERVICE_TOKEN } from '@/core/domain/msTeams/msTeams.service.contract';
import { MSTeamsService } from '@/core/infrastructure/adapters/services/msTeams.service';
import { Module, forwardRef } from '@nestjs/common';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { MsTeamsController } from '@/core/infrastructure/http/controllers/msteams.controller';
import { UseCases } from '@/core/application/use-cases/msteams';
import { TeamMembersModule } from './teamMembers.module';

@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamMembersModule),
    ],
    providers: [
        ...UseCases,
        {
            provide: MSTEAMS_SERVICE_TOKEN,
            useClass: MSTeamsService,
        },
    ],
    controllers: [MsTeamsController],
    exports: [MSTEAMS_SERVICE_TOKEN],
})
export class MSTeamsModule {}
