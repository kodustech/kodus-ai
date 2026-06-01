import { randomUUID } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
    ISSOTestSessionRepository,
    SSO_TEST_SESSION_REPOSITORY_TOKEN,
} from '../domain/contracts/ssoTestSession.repository.contract';

import {
    SSOConnectionTestSession,
    SSOConnectionTestSessionStatus,
    SSOConnectionTestStatus,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../domain/interfaces/ssoConfig.interface';
import {
    buildSSOConfigFingerprint,
    normalizeDomains,
} from '../utils/sso-fingerprint.util';

const SSO_TEST_SESSION_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class SSOTestSessionService {
    constructor(
        @Inject(SSO_TEST_SESSION_REPOSITORY_TOKEN)
        private readonly ssoTestSessionRepository: ISSOTestSessionRepository,
    ) {}

    async createSession<P extends SSOProtocol>(params: {
        organizationId: string;
        protocol: P;
        providerConfig: SSOProtocolConfigMap[P];
        domains: string[];
        createdBy?: string;
    }): Promise<SSOConnectionTestSession<P>> {
        const sessionId = randomUUID();
        const normalizedDomains = normalizeDomains(params.domains);
        const configFingerprint = buildSSOConfigFingerprint({
            protocol: params.protocol,
            providerConfig: params.providerConfig,
            domains: normalizedDomains,
        });

        return this.ssoTestSessionRepository.create<P>({
            sessionId,
            organizationId: params.organizationId,
            protocol: params.protocol,
            status: SSOConnectionTestSessionStatus.PENDING,
            configFingerprint,
            providerConfig: params.providerConfig,
            domains: normalizedDomains,
            createdBy: params.createdBy,
            expiresAt: new Date(Date.now() + SSO_TEST_SESSION_TTL_MS),
        });
    }

    async getSession<P extends SSOProtocol>(
        sessionId: string,
    ): Promise<SSOConnectionTestSession<P> | null> {
        if (!sessionId) {
            return null;
        }

        return this.ssoTestSessionRepository.findValidBySessionId<P>(sessionId);
    }

    async markSessionSuccess<P extends SSOProtocol>(
        sessionId: string,
    ): Promise<SSOConnectionTestSession<P> | null> {
        const session = await this.getSession<P>(sessionId);

        if (!session) {
            return null;
        }

        return this.ssoTestSessionRepository.updateStatus<P>(sessionId, {
            status: SSOConnectionTestSessionStatus.SUCCESS,
            testedAt: new Date(),
            failureCode: undefined,
            failureMessage: undefined,
        });
    }

    async markSessionFailed<P extends SSOProtocol>(
        sessionId: string,
        failure: {
            failureCode: string;
            failureMessage: string;
        },
    ): Promise<SSOConnectionTestSession<P> | null> {
        const session = await this.getSession<P>(sessionId);

        if (!session) {
            return null;
        }

        return this.ssoTestSessionRepository.updateStatus<P>(sessionId, {
            status: SSOConnectionTestSessionStatus.FAILED,
            testedAt: new Date(),
            failureCode: failure.failureCode,
            failureMessage: failure.failureMessage,
        });
    }

    async cleanupExpiredSessions(referenceDate: Date = new Date()) {
        return this.ssoTestSessionRepository.purgeExpired(referenceDate);
    }

    toConnectionTestMetadata<P extends SSOProtocol>(
        session: SSOConnectionTestSession<P>,
    ) {
        return {
            status:
                session.status === SSOConnectionTestSessionStatus.SUCCESS
                    ? SSOConnectionTestStatus.SUCCESS
                    : SSOConnectionTestStatus.FAILED,
            configFingerprint: session.configFingerprint,
            testedAt: session.testedAt
                ? new Date(session.testedAt)
                : new Date(),
            testedBy: session.createdBy,
            failureCode: session.failureCode,
            failureMessage: session.failureMessage,
        };
    }
}
