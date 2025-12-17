import { jwtConfigLoader } from '@/config/loaders/jwt.config.loader';
import { JWT } from '@/config/types/jwt/jwt';
import { UseCases as AuthUseCases } from '@/core/application/use-cases/auth';
import { UseCases as SSOConfigUseCases } from '@/core/application/use-cases/ssoConfig';
import { AUTH_REPOSITORY_TOKEN } from '@/core/domain/auth/contracts/auth.repository.contracts';
import { AUTH_SERVICE_TOKEN } from '@/core/domain/auth/contracts/auth.service.contracts';
import { SSO_CONFIG_REPOSITORY_TOKEN } from '@/core/domain/auth/contracts/ssoConfig.repository.contract';
import { SSO_CONFIG_SERVICE_TOKEN } from '@/core/domain/auth/contracts/ssoConfig.service.contract';
import { AuthRepository } from '@/core/infrastructure/adapters/repositories/typeorm/auth.repository';
import { AuthModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/auth.model';
import { SSOConfigModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/ssoConfig.model';
import { SSOConfigRepository } from '@/core/infrastructure/adapters/repositories/typeorm/ssoConfig.repository';
import { AuthService } from '@/core/infrastructure/adapters/services/auth/auth.service';
import { JwtStrategy } from '@/core/infrastructure/adapters/services/auth/jwt-auth.strategy';
import { SamlStrategy } from '@/core/infrastructure/adapters/services/auth/saml-auth.strategy';
import { SSOConfigService } from '@/core/infrastructure/adapters/services/auth/ssoConfig.service';
import { AuthController } from '@/core/infrastructure/http/controllers/auth.controller';
import { SSOConfigController } from '@/core/infrastructure/http/controllers/ssoConfig.controller';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationModule } from './organization.module';
import { ProfilesModule } from './profiles.module';
import { TeamsModule } from './team.module';
import { TeamMembersModule } from './teamMembers.module';
import { UsersModule } from './user.module';

@Module({
    imports: [
        forwardRef(() => UsersModule),
        TypeOrmModule.forFeature([AuthModel, SSOConfigModel]),
        ConfigModule.forFeature(jwtConfigLoader),
        PassportModule,
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
        forwardRef(() => OrganizationModule),
        TeamMembersModule,
        forwardRef(() => ProfilesModule),
        forwardRef(() => TeamsModule),
    ],
    providers: [
        ...AuthUseCases,
        ...SSOConfigUseCases,
        {
            provide: AUTH_REPOSITORY_TOKEN,
            useClass: AuthRepository,
        },
        JwtStrategy,
        SamlStrategy,
        {
            provide: AUTH_SERVICE_TOKEN,
            useClass: AuthService,
        },
        {
            provide: SSO_CONFIG_REPOSITORY_TOKEN,
            useClass: SSOConfigRepository,
        },
        {
            provide: SSO_CONFIG_SERVICE_TOKEN,
            useClass: SSOConfigService,
        },
    ],
    exports: [AUTH_SERVICE_TOKEN, JwtModule],
    controllers: [AuthController, SSOConfigController],
})
export class AuthModule {}
