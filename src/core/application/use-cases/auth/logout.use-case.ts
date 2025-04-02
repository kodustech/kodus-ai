import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class LogoutUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {}

    async execute(refreshToken: string) {
        try {
            return await this.authService.logout(refreshToken);
        } catch (error) {
            throw new UnauthorizedException('api.users.unauthorized');
        }
    }
}
