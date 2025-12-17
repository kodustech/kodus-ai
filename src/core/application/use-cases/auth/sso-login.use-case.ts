import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SignUpUseCase } from './signup.use-case';

@Injectable()
export class SSOLoginUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly signUpUseCase: SignUpUseCase,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(profile: any, organizationId: string) {
        try {
            const { email, firstName, lastName } = profile;

            let user = await this.authService.validateUser({ email });

            if (!user) {
                user = await this.signUpUseCase.execute({
                    email,
                    name:
                        `${firstName || ''} ${lastName || ''}`.trim() || email,
                    password: randomBytes(32).toString('base64').slice(0, 32),
                    organizationId,
                });
            }

            const { accessToken, refreshToken } = await this.authService.login(
                user,
                AuthProvider.SSO,
            );

            return {
                accessToken,
                refreshToken,
            };
        } catch (error) {
            this.logger.error({
                message: 'SSO login failed',
                error,
                context: SSOLoginUseCase.name,
                metadata: {
                    profile,
                    organizationId,
                },
                serviceName: SSOLoginUseCase.name,
            });
            throw error;
        }
    }
}
