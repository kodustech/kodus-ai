import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from '@libs/common/email/email.module';
import { jwtConfigLoader } from '@libs/core/infrastructure/config/loaders/jwt.config.loader';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import { UseCases as AuthUseCases } from '@libs/identity/application/use-cases/auth';
import { CompleteCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/complete-cli-login.use-case';
import { GetCliLoginInfoUseCase } from '@libs/identity/application/use-cases/cli-auth/get-cli-login-info.use-case';
import { InitiateCliDeviceLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/initiate-cli-device-login.use-case';
import { InitiateCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/initiate-cli-login.use-case';
import { PollCliLoginUseCase } from '@libs/identity/application/use-cases/cli-auth/poll-cli-login.use-case';
import { AUTH_REPOSITORY_TOKEN } from '@libs/identity/domain/auth/contracts/auth.repository.contracts';
import { AUTH_SERVICE_TOKEN } from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { CLI_AUTH_SESSION_REPOSITORY_TOKEN } from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';
import { AuthService } from '@libs/identity/infrastructure/adapters/services/auth/auth.service';
import { JwtStrategy } from '@libs/identity/infrastructure/adapters/services/auth/jwt-auth.strategy';
import { CliAuthSessionRepository } from '../infrastructure/adapters/repositories/cli-auth-session.repository';
import { CliAuthSessionModel } from '../infrastructure/adapters/repositories/schemas/cli-auth-session.model';

import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { TeamMembersModule } from '@libs/organization/modules/teamMembers.module';
import { AuthRepository } from '../infrastructure/adapters/repositories/auth.repository';
import { AuthModel } from '../infrastructure/adapters/repositories/schemas/auth.model';
import { ProfilesModule } from './profiles.module';
import { UserModule } from './user.module';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([AuthModel, CliAuthSessionModel]),
        ConfigModule.forFeature(jwtConfigLoader),
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => ({
                secret: configService.get<JWT>('jwtConfig').secret,
                signOptions: {
                    expiresIn: configService.get<JWT>('jwtConfig').expiresIn,
                },
            }),
        }),
        forwardRef(() => UserModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => ProfilesModule),
        forwardRef(() => TeamModule),
        forwardRef(() => ParametersModule),
        PassportModule,
        TeamMembersModule,
        EmailModule,
        forwardRef(() => NotificationModule),
    ],
    providers: [
        ...AuthUseCases,
        JwtStrategy,
        {
            provide: AUTH_REPOSITORY_TOKEN,
            useClass: AuthRepository,
        },
        {
            provide: AUTH_SERVICE_TOKEN,
            useClass: AuthService,
        },
        // CLI auth (browser/device flows)
        CliAuthSessionRepository,
        {
            provide: CLI_AUTH_SESSION_REPOSITORY_TOKEN,
            useClass: CliAuthSessionRepository,
        },
        InitiateCliLoginUseCase,
        InitiateCliDeviceLoginUseCase,
        CompleteCliLoginUseCase,
        PollCliLoginUseCase,
        GetCliLoginInfoUseCase,
    ],
    exports: [
        AUTH_SERVICE_TOKEN,
        JwtModule,
        AUTH_REPOSITORY_TOKEN,
        ...AuthUseCases,
        InitiateCliLoginUseCase,
        InitiateCliDeviceLoginUseCase,
        CompleteCliLoginUseCase,
        PollCliLoginUseCase,
        GetCliLoginInfoUseCase,
    ],
})
export class AuthModule {}
