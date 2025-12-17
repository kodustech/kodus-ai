import { IOrganization } from '../../organization/interfaces/organization.interface';

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
    createdAt: Date;
    updatedAt: Date;
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
