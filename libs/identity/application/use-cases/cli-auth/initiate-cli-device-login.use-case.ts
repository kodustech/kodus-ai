import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    CLI_AUTH_SESSION_REPOSITORY_TOKEN,
    ICliAuthSessionRepository,
} from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';

const DEVICE_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 5;
// Excludes 0/O/1/I to make the code easy to read aloud.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface InitiateCliDeviceLoginInput {
    userAgent?: string;
}

export interface InitiateCliDeviceLoginResult {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
}

@Injectable()
export class InitiateCliDeviceLoginUseCase
    implements
        IUseCase<InitiateCliDeviceLoginInput, InitiateCliDeviceLoginResult>
{
    constructor(
        @Inject(CLI_AUTH_SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ICliAuthSessionRepository,
        private readonly configService: ConfigService,
    ) {}

    async execute(
        input: InitiateCliDeviceLoginInput,
    ): Promise<InitiateCliDeviceLoginResult> {
        const state = randomBytes(32).toString('hex');
        const deviceCode = randomBytes(32).toString('hex');
        const userCode = this.generateUserCode();
        const expiresAt = new Date(Date.now() + DEVICE_TTL_SECONDS * 1000);

        await this.sessionRepository.create({
            state,
            mode: 'device',
            deviceCode,
            userCode,
            expiresAt,
            userAgent: input.userAgent,
        });

        const frontendUrl =
            this.configService
                .get<string>('API_FRONTEND_URL')
                ?.replace(/\/$/, '') || 'https://app.kodus.io';
        const verificationUri = `${frontendUrl}/cli/authorize`;
        const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(
            userCode,
        )}`;

        return {
            deviceCode,
            userCode,
            verificationUri,
            verificationUriComplete,
            expiresIn: DEVICE_TTL_SECONDS,
            interval: POLL_INTERVAL_SECONDS,
        };
    }

    private generateUserCode(): string {
        // Rejection sampling. `byte % alphabetLength` only stays uniform
        // when alphabetLength divides 256, otherwise the lower codepoints
        // get an extra slot and the user code is biased — flagged by
        // CodeQL as `js/biased-cryptographic-random`. Today's alphabet
        // (32 chars) is uniform under modulo, but we don't want this to
        // silently regress if someone tweaks the alphabet, so we discard
        // any byte in the upper remainder range and resample.
        const alphabetLength = USER_CODE_ALPHABET.length;
        const maxUnbiased =
            Math.floor(256 / alphabetLength) * alphabetLength;
        const out = new Array<string>(8);
        let filled = 0;
        while (filled < 8) {
            const buf = randomBytes(8 - filled);
            for (const byte of buf) {
                if (byte >= maxUnbiased) continue; // discard biased value
                out[filled++] = USER_CODE_ALPHABET[byte % alphabetLength];
                if (filled === 8) break;
            }
        }
        const code = out.join('');
        return `${code.slice(0, 4)}-${code.slice(4)}`;
    }
}
