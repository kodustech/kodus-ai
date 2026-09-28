import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

@Injectable()
export class LoginUseCase implements IUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly telemetry: TelemetryService,
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

            void this.telemetry.userLoggedIn({
                userId: user.uuid,
                organizationId: user.organization?.uuid,
                method: 'password',
            });

            return { accessToken, refreshToken };
        } catch {
            throw new UnauthorizedException('api.users.unauthorized');
        }
    }
}
