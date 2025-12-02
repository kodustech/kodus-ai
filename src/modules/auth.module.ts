import { jwtConfigLoader } from '@/config/loaders/jwt.config.loader';
import { JWT } from '@/config/types/jwt/jwt';
import { UseCases } from '@/core/application/use-cases/auth';
import { AUTH_REPOSITORY_TOKEN } from '@/core/domain/auth/contracts/auth.repository.contracts';
import { AUTH_SERVICE_TOKEN } from '@/core/domain/auth/contracts/auth.service.contracts';
import { AuthRepository } from '@/core/infrastructure/adapters/repositories/typeorm/auth.repository';
import { AuthModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/auth.model';
import { AuthService } from '@/core/infrastructure/adapters/services/auth/auth.service';
import { JwtStrategy } from '@/core/infrastructure/adapters/services/auth/jwt-auth.strategy';
import { AuthController } from '@/core/infrastructure/http/controllers/auth.controller';
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

import { OrganizationParametersModule } from './organizationParameters.module';
import { CheckSSOUseCase } from '@/core/application/use-cases/auth/checkSsoUseCase';
import { SSOLoginUseCase } from '@/core/application/use-cases/auth/ssoLoginUseCase';

@Module({
    imports: [
        forwardRef(() => UsersModule),
        TypeOrmModule.forFeature([AuthModel]),
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
        OrganizationParametersModule,
    ],
    providers: [
        ...UseCases,
        CheckSSOUseCase,
        SSOLoginUseCase,
        {
            provide: AUTH_REPOSITORY_TOKEN,
            useClass: AuthRepository,
        },
        JwtStrategy,
        {
            provide: AUTH_SERVICE_TOKEN,
            useClass: AuthService,
        },
    ],
    exports: [AUTH_SERVICE_TOKEN, JwtModule],
    controllers: [AuthController],
})
export class AuthModule { }
