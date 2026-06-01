import { EmailModule } from '@libs/common/email/email.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { AuthModule } from '@libs/identity/modules/auth.module';
import { UserCoreModule } from '@libs/identity/modules/user-core.module';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SSO_CONFIG_REPOSITORY_TOKEN } from './domain/contracts/ssoConfig.repository.contract';
import { SSO_CONFIG_SERVICE_TOKEN } from './domain/contracts/ssoConfig.service.contract';
import { SSO_TEST_SESSION_REPOSITORY_TOKEN } from './domain/contracts/ssoTestSession.repository.contract';
import { SamlAuthGuard } from './guards/saml-auth.guard';
import { SSOConfigModel } from './repositories/ssoConfig.model';
import { SSOConfigRepository } from './repositories/ssoConfig.repository';
import { SSOTestSessionModel } from './repositories/ssoTestSession.model';
import { SSOTestSessionRepository } from './repositories/ssoTestSession.repository';
import { SSODomainVerificationService } from './services/sso-domain-verification.service';
import { SSOConfigService } from './services/ssoConfig.service';
import { SSOTestSessionService } from './services/sso-test-session.service';
import { SamlStrategy } from './strategies/saml-auth.strategy';
import { UseCases } from './use-cases';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([SSOConfigModel, SSOTestSessionModel]),
        AuthModule,
        UserCoreModule,
        EmailModule,
        LicenseModule,
        forwardRef(() => NotificationModule),
    ],
    providers: [
        SamlStrategy,
        SamlAuthGuard,
        SSOTestSessionService,
        SSODomainVerificationService,
        ...UseCases,
        {
            provide: SSO_CONFIG_REPOSITORY_TOKEN,
            useClass: SSOConfigRepository,
        },
        {
            provide: SSO_CONFIG_SERVICE_TOKEN,
            useClass: SSOConfigService,
        },
        {
            provide: SSO_TEST_SESSION_REPOSITORY_TOKEN,
            useClass: SSOTestSessionRepository,
        },
    ],
    exports: [
        ...UseCases,
        SSO_CONFIG_SERVICE_TOKEN,
        SSOTestSessionService,
        SSODomainVerificationService,
        SamlAuthGuard,
    ],
})
export class SSOModule {}
