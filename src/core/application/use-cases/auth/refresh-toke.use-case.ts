import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class RefreshTokenUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {}

    async execute(oldRefreshToken: string) {
        const newTokens = await this.authService.refreshToken(oldRefreshToken);

        if (!newTokens) {
            throw new Error('Invalid refresh token');
        }

        return newTokens;
    }
}
