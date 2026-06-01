import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    CLI_AUTH_SESSION_REPOSITORY_TOKEN,
    ICliAuthSessionRepository,
} from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';

export interface GetCliLoginInfoInput {
    state?: string;
    userCode?: string;
}

export interface GetCliLoginInfoResult {
    found: boolean;
    state?: string;
    mode?: 'loopback' | 'device';
    status?: string;
    userAgent?: string | null;
    expiresAt?: Date;
}

/**
 * Lets the web /cli/authorize page surface "you are about to authorize the
 * Kodus CLI on <macbook>; expires in 9 min". Pure read; never returns the
 * token or the redirect URI to avoid leaking those to the browser.
 */
@Injectable()
export class GetCliLoginInfoUseCase
    implements IUseCase<GetCliLoginInfoInput, GetCliLoginInfoResult>
{
    constructor(
        @Inject(CLI_AUTH_SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ICliAuthSessionRepository,
    ) {}

    async execute(
        input: GetCliLoginInfoInput,
    ): Promise<GetCliLoginInfoResult> {
        if (!input.state && !input.userCode) {
            return { found: false };
        }

        const session = input.state
            ? await this.sessionRepository.findByState(input.state)
            : await this.sessionRepository.findByUserCode(input.userCode!);

        if (!session) {
            return { found: false };
        }

        return {
            found: true,
            state: session.state,
            mode: session.mode,
            status: session.status,
            userAgent: session.userAgent ?? null,
            expiresAt: session.expiresAt,
        };
    }
}
