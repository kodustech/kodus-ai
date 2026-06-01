import { NotFoundException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { SSOTestSessionService } from '../../services/sso-test-session.service';

@Injectable()
export class GetSSOConnectionTestResultUseCase {
    constructor(
        private readonly ssoTestSessionService: SSOTestSessionService,
    ) {}

    async execute(sessionId: string) {
        const session = await this.ssoTestSessionService.getSession(sessionId);

        if (!session) {
            throw new NotFoundException({
                message: 'SSO test session not found',
                code: 'SSO_TEST_SESSION_NOT_FOUND',
            });
        }

        return {
            sessionId: session.sessionId,
            status: session.status,
            configFingerprint: session.configFingerprint,
            testedAt: session.testedAt,
            failureCode: session.failureCode,
            failureMessage: session.failureMessage,
        };
    }
}
