import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EncryptionUtils } from '../../common/utils/encryption';
import {
    buildAuthorizationUrl,
    checkAndRefreshOAuth,
    discoverOAuth,
    exchangeCodeForTokens,
    generatePKCE,
    generateState,
    getCanonicalResourceUri,
    OAuthAuthorizationServerMetadata,
    OAuthProtectedResourceMetadata,
    registerOauthClient,
    TokenData,
} from '../../common/utils/oauth';
import { Repository } from 'typeorm';
import { MCPIntegrationOAuthEntity } from './entities/mcp-integration-oauth.entity';
import { MCPIntegrationEntity } from './entities/mcp-integration.entity';
import {
    MCPIntegrationAuthType,
    MCPIntegrationOAuthStatus,
} from './enums/integration.enum';
import { MCPIntegrationUniqueFields } from './interfaces/mcp-integration.interface';
import { ManagedTokenCredential } from './managed-credential.types';
import { renderTokenAuthHeaders } from './managed-auth-header';

const MANAGED_TOKEN_KIND = 'managed-token';

type IntegrationOAuthState = Partial<
    MCPIntegrationUniqueFields<MCPIntegrationAuthType.OAUTH2>
>;

@Injectable()
export class IntegrationOAuthService {
    private readonly logger: Logger = new Logger(IntegrationOAuthService.name);
    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(MCPIntegrationOAuthEntity)
        private readonly integrationOAuthRepository: Repository<MCPIntegrationOAuthEntity>,
        private readonly encryptionUtils: EncryptionUtils,
    ) {}

    private decryptAndParse<T>(
        encrypted: string | null | undefined,
        defaultValue: T,
    ): T {
        if (!encrypted) {
            return defaultValue;
        }

        try {
            const decrypted = this.encryptionUtils.decrypt(encrypted);
            return JSON.parse(decrypted) as T;
        } catch (error) {
            this.logger.error('Failed to decrypt or parse OAuth data:', {
                error,
            });
            return defaultValue;
        }
    }

    async getOAuthStatus(
        organizationId: string,
        integrationId: string,
    ): Promise<MCPIntegrationOAuthStatus | null> {
        try {
            const entity = await this.integrationOAuthRepository.findOne({
                where: { integrationId, organizationId },
            });

            if (!entity || !entity.status) {
                return null;
            }

            return entity.status;
        } catch (error) {
            this.logger.error('Failed to get oauth status', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    async getOAuthState(
        organizationId: string,
        integrationId: string,
    ): Promise<IntegrationOAuthState | null> {
        try {
            const entity = await this.integrationOAuthRepository.findOne({
                where: { integrationId, organizationId },
            });

            if (!entity || !entity.auth) {
                return null;
            }

            return this.decryptAndParse<IntegrationOAuthState>(
                entity.auth,
                {} as IntegrationOAuthState,
            );
        } catch (error) {
            this.logger.error('Failed to get oauth state', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    async saveOAuthState(
        organizationId: string,
        integrationId: string,
        status: MCPIntegrationOAuthStatus,
        state: IntegrationOAuthState,
    ): Promise<void> {
        try {
            const payload = this.encryptionUtils.encrypt(JSON.stringify(state));

            let entity = await this.integrationOAuthRepository.findOne({
                where: { integrationId, organizationId },
            });

            if (!entity) {
                entity = this.integrationOAuthRepository.create({
                    organizationId,
                    integrationId,
                    auth: payload,
                    status,
                });
            } else {
                entity.auth = payload;
                entity.status = status;
            }

            await this.integrationOAuthRepository.save(entity);
        } catch (error) {
            this.logger.error('Failed to save oauth state', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    async refreshOAuthStateIfNeeded(params: {
        organizationId: string;
        integrationId: string;
        oauthState: IntegrationOAuthState;
    }): Promise<IntegrationOAuthState> {
        const { organizationId, integrationId } = params;
        let { oauthState } = params;

        const { tokens, clientId, clientSecret, redirectUri, asMetadata } =
            oauthState;

        if (
            !tokens ||
            !asMetadata?.token_endpoint ||
            !redirectUri ||
            !clientId
        ) {
            return oauthState;
        }

        try {
            const newTokens = await checkAndRefreshOAuth(
                asMetadata.token_endpoint,
                {
                    tokens: tokens as TokenData,
                    clientId,
                    clientSecret,
                    redirectUri,
                },
            );

            if (!newTokens) {
                return oauthState;
            }

            oauthState = {
                ...oauthState,
                tokens: newTokens,
            };

            await this.saveOAuthState(
                organizationId,
                integrationId,
                MCPIntegrationOAuthStatus.ACTIVE,
                oauthState,
            );

            return oauthState;
        } catch (error) {
            this.logger.error('Error checking/refreshing OAuth token:', {
                organizationId,
                integrationId,
                error,
            });
            return oauthState;
        }
    }

    async refreshIntegrationOAuthIfNeeded(
        entity: MCPIntegrationEntity,
    ): Promise<void> {
        try {
            if (entity.authType !== MCPIntegrationAuthType.OAUTH2) {
                return;
            }

            const config = this.decryptAndParse<
                MCPIntegrationUniqueFields<MCPIntegrationAuthType.OAUTH2>
            >(entity.auth, {} as any);

            const oauthState = await this.getOAuthState(
                entity.organizationId,
                entity.id,
            );

            if (!oauthState) {
                return;
            }

            const mergedState: IntegrationOAuthState = {
                ...oauthState,
                clientId: oauthState.clientId ?? config.clientId,
                clientSecret: oauthState.clientSecret ?? config.clientSecret,
            };

            await this.refreshOAuthStateIfNeeded({
                organizationId: entity.organizationId,
                integrationId: entity.id,
                oauthState: mergedState,
            });
        } catch (error) {
            this.logger.error('Failed to refresh integration oauth', {
                organizationId: entity.organizationId,
                integrationId: entity.id,
                error,
            });
            throw error;
        }
    }

    async initiateOAuth(params: {
        baseUrl: string;
        oauthScopes: string[];
        dynamicRegistration?: boolean;
        clientId?: string;
        clientSecret?: string;
    }): Promise<{
        authUrl: string;
        clientId: string;
        clientSecret?: string;
        rs: OAuthProtectedResourceMetadata;
        as: OAuthAuthorizationServerMetadata;
        redirectUri: string;
        codeChallenge: string;
        codeVerifier: string;
        state: string;
    }> {
        const {
            baseUrl,
            oauthScopes,
            dynamicRegistration,
            clientId,
            clientSecret,
        } = params;

        try {
            const url = new URL(baseUrl);
            if (url.protocol !== 'https:') {
                throw new Error('Only HTTPS is allowed for OAuth discovery');
            }

            const { rs, as } = await discoverOAuth(baseUrl);

            const {
                authorization_endpoint: authorizationEndpoint,
                token_endpoint: tokenEndpoint,
                registration_endpoint: registrationEndpoint,
            } = as;

            if (!authorizationEndpoint || !tokenEndpoint) {
                throw new Error('Missing authorization or token endpoints');
            }

            const redirectUri = this.configService.get<string>('redirectUri');

            if (!redirectUri) {
                throw new Error('Redirect URI is not configured');
            }

            let effectiveClientId = clientId;
            let effectiveClientSecret = clientSecret;

            if (dynamicRegistration && registrationEndpoint) {
                const regResult = await registerOauthClient(
                    registrationEndpoint,
                    redirectUri,
                    oauthScopes,
                );
                effectiveClientId = regResult.clientId;
                effectiveClientSecret = regResult.clientSecret;
            } else if (!effectiveClientId) {
                throw new Error(
                    'A client_id is required, and dynamic client registration is not supported.',
                );
            }

            const { verifier, challenge } = generatePKCE();
            const state = generateState();

            const authUrl = buildAuthorizationUrl({
                authorizationEndpoint,
                clientId: effectiveClientId,
                redirectUri,
                challenge,
                state,
                baseUrl,
                oauthScopes,
            });

            return {
                authUrl,
                clientId: effectiveClientId,
                clientSecret: effectiveClientSecret,
                rs,
                as,
                redirectUri,
                codeChallenge: challenge,
                codeVerifier: verifier,
                state,
            };
        } catch (error) {
            this.logger.error('Failed to initiate OAuth', {
                error,
            });
            throw error;
        }
    }

    async exchangeAuthorizationCode(params: {
        baseUrl: string;
        tokenEndpoint: string;
        clientId: string;
        clientSecret?: string;
        code: string;
        redirectUri: string;
        codeVerifier: string;
        state: string;
    }) {
        const {
            baseUrl,
            tokenEndpoint,
            clientId,
            clientSecret,
            code,
            redirectUri,
            codeVerifier,
            state,
        } = params;

        try {
            const resource = getCanonicalResourceUri(baseUrl);

            const tokens = await exchangeCodeForTokens(tokenEndpoint, {
                clientId,
                clientSecret,
                code,
                codeVerifier,
                redirectUri,
                resource,
                state,
            });

            return tokens;
        } catch (error) {
            this.logger.error('Failed to exchange authorization code', {
                error,
            });
            throw error;
        }
    }

    /**
     * Persist a per-org static-token credential for a managed integration
     * (bring-your-own-token auth method). Reuses the `mcp_integration_oauth`
     * row for (org, integrationId); the payload is tagged `kind: 'managed-token'`
     * so it is never confused with OAuth state.
     */
    async saveTokenCredential(
        organizationId: string,
        integrationId: string,
        credential: ManagedTokenCredential,
    ): Promise<void> {
        try {
            const payload = this.encryptionUtils.encrypt(
                JSON.stringify({
                    kind: MANAGED_TOKEN_KIND,
                    ...credential,
                }),
            );

            let entity = await this.integrationOAuthRepository.findOne({
                where: { integrationId, organizationId },
            });

            if (!entity) {
                entity = this.integrationOAuthRepository.create({
                    organizationId,
                    integrationId,
                    auth: payload,
                    status: MCPIntegrationOAuthStatus.ACTIVE,
                });
            } else {
                entity.auth = payload;
                entity.status = MCPIntegrationOAuthStatus.ACTIVE;
            }

            await this.integrationOAuthRepository.save(entity);
        } catch (error) {
            this.logger.error('Failed to save token credential', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    /**
     * Read the per-org static-token credential for a managed integration, or
     * `null` when none is stored (or the row holds OAuth state instead).
     */
    async getManagedCredential(
        organizationId: string,
        integrationId: string,
    ): Promise<ManagedTokenCredential | null> {
        try {
            const entity = await this.integrationOAuthRepository.findOne({
                where: { integrationId, organizationId },
            });

            if (!entity?.auth) {
                return null;
            }

            const parsed = this.decryptAndParse<
                ({ kind?: string } & ManagedTokenCredential) | null
            >(entity.auth, null);

            if (!parsed || parsed.kind !== MANAGED_TOKEN_KIND) {
                return null;
            }

            const { kind: _kind, ...credential } = parsed;
            return credential;
        } catch (error) {
            this.logger.error('Failed to get managed credential', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    /**
     * Resolve the ready-to-send auth header(s) for a managed (kodusmcp)
     * connection on the agent-runtime path. Picks the credential that exists for
     * (org, integrationId): a stored static-token credential takes precedence,
     * otherwise the OAuth access token (refreshed on read). Returns `{}` when the
     * integration needs no auth (e.g. `none` servers).
     */
    async resolveManagedAuthHeaders(
        organizationId: string,
        integrationId: string,
    ): Promise<Record<string, string>> {
        const credential = await this.getManagedCredential(
            organizationId,
            integrationId,
        );

        if (credential) {
            return renderTokenAuthHeaders(credential);
        }

        let oauthState = await this.getOAuthState(
            organizationId,
            integrationId,
        );

        if (oauthState?.tokens) {
            oauthState = await this.refreshOAuthStateIfNeeded({
                organizationId,
                integrationId,
                oauthState,
            });

            const accessToken = (oauthState.tokens as TokenData)?.accessToken;
            if (accessToken) {
                return { Authorization: `Bearer ${accessToken}` };
            }
        }

        return {};
    }

    /**
     * Whether the org has *any* usable credential for a managed integration —
     * a stored static token, or an ACTIVE OAuth grant. Method-agnostic, so it is
     * correct regardless of which auth method the org connected with.
     */
    async hasManagedCredential(
        organizationId: string,
        integrationId: string,
    ): Promise<boolean> {
        const credential = await this.getManagedCredential(
            organizationId,
            integrationId,
        );

        if (credential) {
            return true;
        }

        const status = await this.getOAuthStatus(organizationId, integrationId);
        return status === MCPIntegrationOAuthStatus.ACTIVE;
    }

    async deleteOAuthState(
        organizationId: string,
        integrationId: string,
    ): Promise<void> {
        try {
            await this.integrationOAuthRepository.delete({
                organizationId,
                integrationId,
            });
        } catch (error) {
            this.logger.error('Failed to delete OAuth state', {
                error,
            });
            throw error;
        }
    }
}
