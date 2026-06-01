import {
    OAuthAuthorizationServerMetadata,
    OAuthProtectedResourceMetadata,
    TokenData,
} from '../../../common/utils/oauth';
import { MCPIntegrationEntity } from '../entities/mcp-integration.entity';
import { MCPIntegrationAuthType } from '../enums/integration.enum';

export type MCPIntegrationInterface =
    | MCPIntegrationNone
    | MCPIntegrationBearerToken
    | MCPIntegrationApiKey
    | MCPIntegrationBasic
    | MCPIntegrationOAuth2;

export interface MCPIntegrationBase extends Omit<
    MCPIntegrationEntity,
    'authType' | 'auth' | 'headers'
> {
    headers?: Record<string, string>;
}

interface MCPIntegrationNone extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.NONE;
}

interface MCPIntegrationBearerToken extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.BEARER_TOKEN;
    bearerToken: string;
}

interface MCPIntegrationApiKey extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.API_KEY;
    apiKey: string;
    apiKeyHeader: string;
}

interface MCPIntegrationBasic extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.BASIC;
    basicUser: string;
    basicPassword?: string;
}

interface MCPIntegrationOAuth2 extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.OAUTH2;
    clientId: string;
    clientSecret?: string;
    oauthScopes?: string[];
    asMetadata?: OAuthAuthorizationServerMetadata;
    rsMetadata?: OAuthProtectedResourceMetadata;
    redirectUri?: string;
    tokens: TokenData;
    codeChallenge: string;
    codeVerifier: string;
    state: string;
    dynamicRegistration: boolean;
}

export type MCPIntegrationAllUniqueFields = UnionToIntersection<
    {
        [T in MCPIntegrationAuthType]: MCPIntegrationUniqueFields<T>;
    }[MCPIntegrationAuthType]
>;

export type MCPIntegrationUniqueFields<T extends MCPIntegrationAuthType> = Omit<
    Extract<MCPIntegrationInterface, { authType: T }>,
    keyof MCPIntegrationBase | 'authType'
>;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
    k: infer I,
) => void
    ? I
    : never;
