import {
    SSOProtocol,
    SSOConnectionTestSession,
    SSOConnectionTestSessionStatus,
    SSOProtocolConfigMap,
} from '../interfaces/ssoConfig.interface';
import { Entity } from '@libs/core/domain/interfaces/entity';

export class SSOTestSessionEntity<P extends SSOProtocol> implements Entity<
    SSOConnectionTestSession<P>
> {
    private _sessionId: string;
    private _organizationId: string;
    private _protocol: P;
    private _status: SSOConnectionTestSessionStatus;
    private _configFingerprint: string;
    private _providerConfig: SSOProtocolConfigMap[P];
    private _domains: string[];
    private _createdBy?: string;
    private _createdAt: Date;
    private _updatedAt: Date;
    private _expiresAt: Date;
    private _testedAt?: Date;
    private _failureCode?: string;
    private _failureMessage?: string;

    constructor(
        session:
            | SSOConnectionTestSession<P>
            | Partial<SSOConnectionTestSession<P>>,
    ) {
        const sessionWithOrganization = session as Partial<
            SSOConnectionTestSession<P>
        > & {
            organization?: {
                uuid?: string;
            };
        };

        this._sessionId = session.sessionId;
        this._organizationId =
            sessionWithOrganization.organizationId ||
            sessionWithOrganization.organization?.uuid;
        this._protocol = session.protocol;
        this._status = session.status;
        this._configFingerprint = session.configFingerprint;
        this._providerConfig = session.providerConfig;
        this._domains = session.domains;
        this._createdBy = session.createdBy;
        this._createdAt = new Date(session.createdAt);
        this._updatedAt = new Date(session.updatedAt);
        this._expiresAt = new Date(session.expiresAt);
        this._testedAt = session.testedAt
            ? new Date(session.testedAt)
            : undefined;
        this._failureCode = session.failureCode;
        this._failureMessage = session.failureMessage;
    }

    public static create<P extends SSOProtocol>(
        session:
            | SSOConnectionTestSession<P>
            | Partial<SSOConnectionTestSession<P>>,
    ): SSOTestSessionEntity<P> {
        return new SSOTestSessionEntity<P>(session);
    }

    public toObject(): SSOConnectionTestSession<P> {
        return {
            sessionId: this.sessionId,
            organizationId: this.organizationId,
            protocol: this.protocol,
            status: this.status,
            configFingerprint: this.configFingerprint,
            providerConfig: this.providerConfig,
            domains: this.domains,
            createdBy: this.createdBy,
            createdAt: this.createdAt.toISOString(),
            updatedAt: this.updatedAt.toISOString(),
            expiresAt: this.expiresAt.toISOString(),
            testedAt: this.testedAt ? this.testedAt.toISOString() : undefined,
            failureCode: this.failureCode,
            failureMessage: this.failureMessage,
        };
    }

    public toJson():
        | SSOConnectionTestSession<P>
        | Partial<SSOConnectionTestSession<P>> {
        return this.toObject();
    }

    public get sessionId() {
        return this._sessionId;
    }

    public get organizationId() {
        return this._organizationId;
    }

    public get protocol() {
        return this._protocol;
    }

    public get status() {
        return this._status;
    }

    public get configFingerprint() {
        return this._configFingerprint;
    }

    public get providerConfig() {
        return this._providerConfig;
    }

    public get domains() {
        return this._domains;
    }

    public get createdBy() {
        return this._createdBy;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get updatedAt() {
        return this._updatedAt;
    }

    public get expiresAt() {
        return this._expiresAt;
    }

    public get testedAt() {
        return this._testedAt;
    }

    public get failureCode() {
        return this._failureCode;
    }

    public get failureMessage() {
        return this._failureMessage;
    }
}
