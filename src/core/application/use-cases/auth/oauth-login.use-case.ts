import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CreateOrganizationFromOAuthUseCase } from '../organization/create-from-oauth.use-case';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';

@Injectable()
export class OAuthLoginUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly createOrganizationFromOAuthUseCase: CreateOrganizationFromOAuthUseCase,
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
                user = await this.createOrganizationFromOAuthUseCase.execute(
                    { name },
                    { email },
                );
            }

            const { accessToken, refreshToken } = await this.authService.login(
                user as IUser,
                authProvider,
                {
                    refreshToken: providerRefreshToken,
                },
            );

            return { accessToken, refreshToken };
        } catch (error) {
            throw new UnauthorizedException('api.users.unauthorized');
        }
    }
}
