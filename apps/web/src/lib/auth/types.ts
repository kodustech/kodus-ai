export enum AuthProviders {
    CREDENTIALS = "credentials",
    GOOGLE = "google",
    GITHUB = "github",
    GITLAB = "gitlab",
    SSO = "sso",
}

export enum SSOProtocol {
    SAML = "saml",
    OIDC = "oidc",
}

export interface SSOConfig<P extends SSOProtocol> {
    uuid?: string;
    protocol: P;
    active: boolean;
    providerConfig: SSOProtocolConfigMap[P];
    domains: string[];
    connectionTest?: SSOConnectionTestMetadata;
    domainVerification?: SSODomainVerificationMetadata;
    createdAt?: string;
    updatedAt?: string;
}

export interface SSODomainVerificationRecord {
    domain: string;
    verifiedAt: string;
    verifiedByEmail: string;
}

export interface SSODomainVerificationMetadata {
    verifiedDomains: SSODomainVerificationRecord[];
}

export enum SSOConnectionTestStatus {
    SUCCESS = "success",
    FAILED = "failed",
}

export interface SSOConnectionTestMetadata {
    status: SSOConnectionTestStatus;
    configFingerprint: string;
    testedAt: string;
    testedBy?: string;
    failureCode?: string;
    failureMessage?: string;
}

export enum SSOConnectionTestSessionStatus {
    PENDING = "pending",
    SUCCESS = "success",
    FAILED = "failed",
}

export interface StartSSOConnectionTestResponse {
    sessionId: string;
    redirectUrl: string;
    configFingerprint: string;
}

export interface GetSSOConnectionTestResultResponse {
    sessionId: string;
    status: SSOConnectionTestSessionStatus;
    configFingerprint: string;
    failureCode?: string;
    failureMessage?: string;
    testedAt?: string;
}

export interface RequestSSODomainVerificationResponse {
    domain: string;
    contactEmail: string;
    sent: boolean;
}

export interface ConfirmSSODomainVerificationResponse {
    domain: string;
    verifiedAt: string;
    verifiedByEmail: string;
}

export interface SSODomainVerificationStatusItem {
    domain: string;
    verified: boolean;
    verifiedAt?: string;
    verifiedByEmail?: string;
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
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    scope?: string;
}
