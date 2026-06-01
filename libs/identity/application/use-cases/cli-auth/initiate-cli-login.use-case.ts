import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    CLI_AUTH_SESSION_REPOSITORY_TOKEN,
    ICliAuthSessionRepository,
} from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';

const SESSION_TTL_SECONDS = 10 * 60;
const ALLOWED_LOOPBACK_HOSTS = new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
    '::1',
]);

export interface InitiateCliLoginInput {
    port?: number;
    userAgent?: string;
}

export interface InitiateCliLoginResult {
    verificationUri: string;
    state: string;
    expiresIn: number;
}

@Injectable()
export class InitiateCliLoginUseCase
    implements IUseCase<InitiateCliLoginInput, InitiateCliLoginResult>
{
    constructor(
        @Inject(CLI_AUTH_SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ICliAuthSessionRepository,
        private readonly configService: ConfigService,
    ) {}

    async execute(
        input: InitiateCliLoginInput,
    ): Promise<InitiateCliLoginResult> {
        const state = randomBytes(32).toString('hex');
        const port = this.validatePort(input.port);
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

        await this.sessionRepository.create({
            state,
            mode: 'loopback',
            expiresAt,
            redirectUri,
            userAgent: input.userAgent,
        });

        const frontendUrl =
            this.configService
                .get<string>('API_FRONTEND_URL')
                ?.replace(/\/$/, '') || 'https://app.kodus.io';

        const verificationUri = `${frontendUrl}/cli/authorize?state=${encodeURIComponent(state)}`;

        return {
            verificationUri,
            state,
            expiresIn: SESSION_TTL_SECONDS,
        };
    }

    private validatePort(port?: number): number {
        if (
            !port ||
            !Number.isInteger(port) ||
            port < 1024 ||
            port > 65535
        ) {
            throw new Error('Invalid loopback port');
        }
        return port;
    }

    /** Exposed for the controller to validate redirect_uri before redirecting. */
    static isLoopbackRedirect(uri: string | null | undefined): boolean {
        if (!uri) return false;
        try {
            const parsed = new URL(uri);
            if (parsed.protocol !== 'http:') return false;
            return ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname);
        } catch {
            return false;
        }
    }
}
