import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { AuthProvider } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    CLI_AUTH_SESSION_REPOSITORY_TOKEN,
    ICliAuthSessionRepository,
} from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';
import { UserEntity } from '@libs/identity/domain/user/entities/user.entity';

import { InitiateCliLoginUseCase } from './initiate-cli-login.use-case';

export interface CompleteCliLoginInput {
    /** Loopback flow uses state, device flow uses userCode. Exactly one must be provided. */
    state?: string;
    userCode?: string;
    user: Partial<UserEntity>;
}

export interface CompleteCliLoginResult {
    redirectUri?: string | null;
    state: string;
    mode: 'loopback' | 'device';
}

@Injectable()
export class CompleteCliLoginUseCase
    implements IUseCase<CompleteCliLoginInput, CompleteCliLoginResult>
{
    constructor(
        @Inject(CLI_AUTH_SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ICliAuthSessionRepository,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {}

    async execute(
        input: CompleteCliLoginInput,
    ): Promise<CompleteCliLoginResult> {
        if ((!input.state && !input.userCode) || !input.user?.uuid) {
            throw new BadRequestException(
                'state or userCode is required, plus an authenticated user',
            );
        }

        const session = input.state
            ? await this.sessionRepository.findByState(input.state)
            : await this.sessionRepository.findByUserCode(input.userCode!);

        if (!session) {
            throw new NotFoundException('CLI auth session not found');
        }

        if (session.status !== 'pending') {
            throw new BadRequestException(
                `CLI auth session is ${session.status}`,
            );
        }

        if (session.expiresAt.getTime() < Date.now()) {
            throw new BadRequestException('CLI auth session expired');
        }

        if (
            session.mode === 'loopback' &&
            !InitiateCliLoginUseCase.isLoopbackRedirect(session.redirectUri)
        ) {
            throw new BadRequestException(
                'Stored redirect URI is not a loopback address',
            );
        }

        const tokens = await this.authService.login(
            input.user,
            AuthProvider.CREDENTIALS,
        );

        await this.sessionRepository.complete(session.uuid, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            userId: input.user.uuid,
            userEmail: input.user.email ?? null,
        });

        return {
            redirectUri: session.redirectUri,
            state: session.state,
            mode: session.mode,
        };
    }
}
