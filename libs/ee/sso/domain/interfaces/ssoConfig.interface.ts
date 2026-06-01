import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';

export enum SSOProtocol {
    SAML = 'saml',
    OIDC = 'oidc',
}

export interface SSOConfig<P extends SSOProtocol> {
    uuid: string;
    organization: Partial<IOrganization>;
    protocol: P;
    active: boolean;
    domains: string[];
    providerConfig: SSOProtocolConfigMap[P];
    connectionTest?: SSOConnectionTestMetadata;
    domainVerification?: SSODomainVerificationMetadata;
    createdAt: Date;
    updatedAt: Date;
}

export interface SSODomainVerificationRecord {
    domain: string;
    verifiedAt: Date;
    verifiedByEmail: string;
}

export interface SSODomainVerificationMetadata {
    verifiedDomains: SSODomainVerificationRecord[];
}

export enum SSOConnectionTestStatus {
    SUCCESS = 'success',
    FAILED = 'failed',
}

export enum SSOConnectionTestSessionStatus {
    PENDING = 'pending',
    SUCCESS = 'success',
    FAILED = 'failed',
}

export interface SSOConnectionTestMetadata {
    status: SSOConnectionTestStatus;
    configFingerprint: string;
    testedAt: Date;
    testedBy?: string;
    failureCode?: string;
    failureMessage?: string;
}

export interface SSOConnectionTestSession<P extends SSOProtocol> {
    sessionId: string;
    organizationId: string;
    protocol: P;
    status: SSOConnectionTestSessionStatus;
    configFingerprint: string;
    providerConfig: SSOProtocolConfigMap[P];
    domains: string[];
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    failureCode?: string;
    failureMessage?: string;
    testedAt?: string;
}

export type SSOProtocolConfigMap = {
    [SSOProtocol.SAML]: SAMLConfig;
    [SSOProtocol.OIDC]: OIDCConfig;
};

export interface SAMLConfig {
    entryPoint: string;
    idpIssuer: string;
    issuer?: string;
    cert: string;
    identifierFormat?: string;
}

export interface OIDCConfig {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    scope?: string;
    attributeMap?: Record<string, string>;
}
