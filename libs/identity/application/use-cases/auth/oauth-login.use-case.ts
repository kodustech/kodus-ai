import { randomBytes } from 'crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

import { SignUpUseCase } from './signup.use-case';

@Injectable()
export class OAuthLoginUseCase implements IUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly signUpUseCase: SignUpUseCase,
        private readonly telemetry: TelemetryService,
    ) {}

    async execute(
        name: string,
        email: string,
        providerRefreshToken: string,
        authProvider: AuthProvider,
    ) {
        try {
            let user = await this.authService.validateUser({
                email,
            });

            if (!user) {
                user = await this.signUpUseCase.execute({
                    email,
                    name,
                    password: randomBytes(32).toString('base64').slice(0, 32),
                });
            }

            const { accessToken, refreshToken } = await this.authService.login(
                user as IUser,
                authProvider,
                {
                    refreshToken: providerRefreshToken,
                },
            );

            void this.telemetry.userLoggedIn({
                userId: user.uuid,
                organizationId: user.organization?.uuid,
                method: 'oauth',
                provider: authProvider,
            });

            return { accessToken, refreshToken };
        } catch (error) {
            throw new UnauthorizedException('api.users.unauthorized');
        }
    }
}
