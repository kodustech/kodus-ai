import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class LoginUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {}

    async execute(email: string, password: string) {
        try {
            const user = await this.authService.validateUser({
                email,
            });

            if (!user) {
                throw new UnauthorizedException('api.users.unauthorized');
            }

            if (!(await this.authService.match(password, user.password))) {
                throw new UnauthorizedException('api.users.unauthorized');
            }

            const { accessToken, refreshToken } = await this.authService.login(
                user,
                AuthProvider.CREDENTIALS,
            );

            return { accessToken, refreshToken };
        } catch (error) {
            throw new UnauthorizedException('api.users.unauthorized');
        }
    }
}
