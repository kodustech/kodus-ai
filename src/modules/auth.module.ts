import { jwtConfigLoader } from '@/config/loaders/jwt.config.loader';
import { JWT } from '@/config/types/jwt/jwt';
import { UseCases } from '@/core/application/use-cases/auth';
import { AUTH_REPOSITORY_TOKEN } from '@/core/domain/auth/contracts/auth.repository.contracts';
import { AUTH_SERVICE_TOKEN } from '@/core/domain/auth/contracts/auth.service.contracts';
import { AuthRepository } from '@/core/infrastructure/adapters/repositories/typeorm/auth.repository';
import { AuthModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/auth.model';
import { AuthController } from '@/core/infrastructure/http/controllers/auth.controller';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './user.module';
import { AuthService } from '@/core/infrastructure/adapters/services/auth/auth.service';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from '@/core/infrastructure/adapters/services/auth/jwt-auth.strategy';
import { CreateOrganizationUseCase } from '@/core/application/use-cases/organization/create.use-case';
import { OrganizationModule } from './organization.module';
import { TeamMembersModule } from './teamMembers.module';
import { CreateOrganizationFromOAuthUseCase } from '@/core/application/use-cases/organization/create-from-oauth.use-case';

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
    ],
    providers: [
        ...UseCases,
        {
            provide: AUTH_REPOSITORY_TOKEN,
            useClass: AuthRepository,
        },
        JwtStrategy,
        {
            provide: AUTH_SERVICE_TOKEN,
            useClass: AuthService,
        },
        CreateOrganizationUseCase,
        CreateOrganizationFromOAuthUseCase,
    ],
    exports: [AUTH_SERVICE_TOKEN, JwtModule],
    controllers: [AuthController],
})
export class AuthModule {}
