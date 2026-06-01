import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from '@libs/common/email/email.module';
import { DeleteUserUseCase } from '@libs/identity/application/use-cases/user/delete.use-case';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { TeamMemberModel } from '../infrastructure/adapters/repositories/schemas/teamMember.model';
import { TeamMemberService } from '../infrastructure/adapters/services/teamMembers.service';
import { TeamMemberDatabaseRepository } from '../infrastructure/adapters/repositories/teamMember.repository';

import { ParametersModule } from './parameters.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { CreateOrUpdateTeamMembersUseCase } from '../application/use-cases/teamMembers/create.use-case';
import { GetTeamMembersUseCase } from '../application/use-cases/teamMembers/get-team-members.use-case';
import { DeleteTeamMembersUseCase } from '../application/use-cases/teamMembers/delete.use-case';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '../domain/teamMembers/contracts/teamMembers.service.contracts';
import { TEAM_MEMBERS_REPOSITORY_TOKEN } from '../domain/teamMembers/contracts/teamMembers.repository.contracts';
import { UserModule } from '@libs/identity/modules/user.module';
import { TeamModule } from './team.module';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([TeamMemberModel]),
        forwardRef(() => TeamModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => UserModule),
        forwardRef(() => ParametersModule),
        EmailModule,
        forwardRef(() => NotificationModule),
    ],
    providers: [
        CreateOrUpdateTeamMembersUseCase,
        GetTeamMembersUseCase,
        DeleteTeamMembersUseCase,
        DeleteUserUseCase,
        {
            provide: TEAM_MEMBERS_SERVICE_TOKEN,
            useClass: TeamMemberService,
        },
        {
            provide: TEAM_MEMBERS_REPOSITORY_TOKEN,
            useClass: TeamMemberDatabaseRepository,
        },
    ],
    exports: [
        TEAM_MEMBERS_SERVICE_TOKEN,
        TEAM_MEMBERS_REPOSITORY_TOKEN,
        CreateOrUpdateTeamMembersUseCase,
        GetTeamMembersUseCase,
        DeleteTeamMembersUseCase,
    ],
})
export class TeamMembersCoreModule {}
