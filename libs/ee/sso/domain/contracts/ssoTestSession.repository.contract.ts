import {
    SSOConnectionTestSession,
    SSOConnectionTestSessionStatus,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../interfaces/ssoConfig.interface';

export const SSO_TEST_SESSION_REPOSITORY_TOKEN = Symbol.for(
    'SSOTestSessionRepository',
);

export interface CreateSSOTestSessionPayload<P extends SSOProtocol> {
    sessionId: string;
    organizationId: string;
    protocol: P;
    status: SSOConnectionTestSessionStatus;
    configFingerprint: string;
    providerConfig: SSOProtocolConfigMap[P];
    domains: string[];
    createdBy?: string;
    testedAt?: Date;
    failureCode?: string;
    failureMessage?: string;
    expiresAt: Date;
}

export interface UpdateSSOTestSessionStatusPayload {
    status: SSOConnectionTestSessionStatus;
    testedAt: Date;
    failureCode?: string;
    failureMessage?: string;
}

export interface ISSOTestSessionRepository {
    create<P extends SSOProtocol>(
        payload: CreateSSOTestSessionPayload<P>,
    ): Promise<SSOConnectionTestSession<P>>;

    findValidBySessionId<P extends SSOProtocol>(
        sessionId: string,
    ): Promise<SSOConnectionTestSession<P> | null>;

    updateStatus<P extends SSOProtocol>(
        sessionId: string,
        payload: UpdateSSOTestSessionStatusPayload,
    ): Promise<SSOConnectionTestSession<P> | null>;

    purgeExpired(referenceDate: Date): Promise<number>;
}
