import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    CLI_AUTH_SESSION_REPOSITORY_TOKEN,
    ICliAuthSessionRepository,
} from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';

export type PollCliLoginStatus =
    | 'pending'
    | 'completed'
    | 'consumed'
    | 'denied'
    | 'expired'
    | 'not_found';

export interface PollCliLoginInput {
    /** Loopback flow polls by state, device flow polls by deviceCode. */
    state?: string;
    deviceCode?: string;
}

export interface PollCliLoginResult {
    status: PollCliLoginStatus;
    accessToken?: string;
    refreshToken?: string;
    userEmail?: string;
}

@Injectable()
export class PollCliLoginUseCase
    implements IUseCase<PollCliLoginInput, PollCliLoginResult>
{
    constructor(
        @Inject(CLI_AUTH_SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ICliAuthSessionRepository,
    ) {}

    async execute(input: PollCliLoginInput): Promise<PollCliLoginResult> {
        if (!input.state && !input.deviceCode) {
            return { status: 'not_found' };
        }

        const session = input.state
            ? await this.sessionRepository.findByState(input.state)
            : await this.sessionRepository.findByDeviceCode(input.deviceCode!);

        if (!session) {
            return { status: 'not_found' };
        }

        if (
            session.status === 'pending' &&
            session.expiresAt.getTime() < Date.now()
        ) {
            return { status: 'expired' };
        }

        if (session.status !== 'completed') {
            return { status: session.status };
        }

        // One-shot: mark consumed and return tokens. Subsequent polls will
        // get { status: 'consumed' } with no token, so a leaked state can't
        // be replayed to retrieve the JWT a second time.
        await this.sessionRepository.markConsumed(session.uuid);

        return {
            status: 'completed',
            accessToken: session.accessToken ?? undefined,
            refreshToken: session.refreshToken ?? undefined,
            userEmail: session.userEmail ?? undefined,
        };
    }
}
