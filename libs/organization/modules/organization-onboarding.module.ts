import { Module, forwardRef } from '@nestjs/common';
import { EmailModule } from '@libs/common/email/email.module';
import { UserModule } from '@libs/identity/modules/user.module';
import { OrganizationModule } from './organization.module';
import { TeamModule } from './team.module';
import { TeamMembersModule } from './teamMembers.module';
import { ProfilesModule } from '@libs/identity/modules/profiles.module';
import { AuthModule } from '@libs/identity/modules/auth.module';
import { ParametersModule } from './parameters.module';
import { JoinOrganizationUseCase } from '../application/use-cases/onboarding/join-organization.use-case';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

@Module({
    imports: [
        forwardRef(() => UserModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => TeamModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => ProfilesModule),
        forwardRef(() => AuthModule),
        forwardRef(() => ParametersModule),
        EmailModule,
        forwardRef(() => NotificationModule),
    ],
    providers: [JoinOrganizationUseCase],
    exports: [JoinOrganizationUseCase],
})
export class OrganizationOnboardingModule {}
