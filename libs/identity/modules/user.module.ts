import { Module, forwardRef } from '@nestjs/common';

import { ProfilesModule } from './profiles.module';
import { UserCoreModule } from './user-core.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { TeamMembersModule } from '@libs/organization/modules/teamMembers.module';
import { CryptoModule } from '@libs/core/crypto/crypto.module';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

import { UpdateAnotherUserUseCase } from '../application/use-cases/user/update-another.use-case';
import { AcceptUserInvitationUseCase } from '../application/use-cases/user/accept-user-invitation.use-case';
import { SaveMarketingSurveyUseCase } from '../application/use-cases/profile/save-marketing-survey.use-case';

@Module({
    imports: [
        forwardRef(() => ProfilesModule),
        UserCoreModule,
        forwardRef(() => OrganizationModule),
        forwardRef(() => TeamModule),
        forwardRef(() => TeamMembersModule),
        CryptoModule,
        forwardRef(() => NotificationModule),
    ],
    providers: [
        UpdateAnotherUserUseCase,
        AcceptUserInvitationUseCase,
        SaveMarketingSurveyUseCase,
    ],
    exports: [
        UserCoreModule,
        UpdateAnotherUserUseCase,
        AcceptUserInvitationUseCase,
        SaveMarketingSurveyUseCase,
    ],
})
export class UserModule {}
