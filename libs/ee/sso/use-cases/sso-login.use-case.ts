import { randomBytes } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@kodus/flow';
import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { SignUpUseCase } from '@libs/identity/application/use-cases/auth/signup.use-case';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

// A successful SSO assertion is proof the IdP owns the email, so any
// pre-existing account that never finished email confirmation can be
// safely promoted. Without this, the JWT keeps status=pending and the
// web middleware redirects to /confirm-email after a valid SSO login.
const UNCONFIRMED_STATUSES: readonly STATUS[] = [
    STATUS.PENDING,
    STATUS.PENDING_EMAIL,
];

@Injectable()
export class SSOLoginUseCase implements IUseCase {
    private readonly logger = createLogger(SSOLoginUseCase.name);

    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly signUpUseCase: SignUpUseCase,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}

    async execute(profile: any, organizationId: string) {
        try {
            const { email, firstName, lastName } = profile;

            let user = await this.authService.validateUser({ email });

            if (!user) {
                user = await this.signUpUseCase.execute(
                    {
                        email,
                        name:
                            `${firstName || ''} ${lastName || ''}`.trim() ||
                            email,
                        password: randomBytes(32).toString('base64').slice(0, 32),
                        organizationId,
                    },
                    { preVerified: true },
                );
            } else if (UNCONFIRMED_STATUSES.includes(user.status as STATUS)) {
                await this.usersService.update(
                    { email },
                    { status: STATUS.ACTIVE },
                );
                // Re-fetch so the freshly persisted ACTIVE status flows
                // into the issued token. `UserEntity` exposes `status` as a
                // read-only getter and relations (organization) as
                // non-enumerable, so it can be neither mutated nor spread.
                user = await this.authService.validateUser({ email });
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
