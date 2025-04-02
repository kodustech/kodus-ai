import { UseCases } from '@/core/application/use-cases/teamMembers';
import { TEAM_MEMBERS_REPOSITORY_TOKEN } from '@/core/domain/teamMembers/contracts/teamMembers.repository.contracts';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMembersController } from '@/core/infrastructure/http/controllers/teamMembers.controller';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SlackModule } from './slack.module';
import { UsersModule } from '@/modules/user.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { MSTeamsModule } from './msTeams.module';
import { TeamMemberModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/teamMember.model';
import { TeamMemberService } from '@/core/infrastructure/adapters/services/teamMembers.service';
import { TeamMemberDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/teamMember.repository';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { TeamsModule } from './team.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { IntegrationModule } from './integration.module';
import { DeleteUserUseCase } from '@/core/application/use-cases/user/delete.use-case';
import { ParametersModule } from './parameters.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([TeamMemberModel]),
        forwardRef(() => MSTeamsModule),
        forwardRef(() => SlackModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => UsersModule),
        forwardRef(() => ParametersModule),
        MSTeamsModule,
    ],
    providers: [
        ...UseCases,
        DeleteUserUseCase,
        PromptService,
        {
            provide: TEAM_MEMBERS_SERVICE_TOKEN,
            useClass: TeamMemberService,
        },
        {
            provide: TEAM_MEMBERS_REPOSITORY_TOKEN,
            useClass: TeamMemberDatabaseRepository,
        },
    ],
    exports: [TEAM_MEMBERS_SERVICE_TOKEN, TEAM_MEMBERS_REPOSITORY_TOKEN],
    controllers: [TeamMembersController],
})
export class TeamMembersModule { }
