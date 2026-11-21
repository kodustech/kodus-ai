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
    OAuthGrantRejectedError,
    OAuthProtectedResourceMetadata,
    registerOauthClient,
    shouldRefreshOAuth,
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
import { credentialFingerprint } from '@libs/mcp-server/credential-fingerprint';

const MANAGED_TOKEN_KIND = 'managed-token';

/**
 * What a refused credential led to: `stale` (an older credential, nothing
 * done), `token_rejected` (the stored static token is refused, INACTIVE),
 * `grant_lost` (OAuth grant INACTIVE), `refreshed` (a new access token is
 * stored), `kept` (the refresh failed for a reason that says nothing about
 * the grant, such as a network error, a 5xx or a refresh lock held too long;
 * the grant stays as it is).
 */
export type RejectedCredentialOutcome =
    'stale' | 'token_rejected' | 'grant_lost' | 'refreshed' | 'kept';

/**
 * A refresh under the grant's lock: `refreshed` (new tokens stored),
 * `superseded` (another refresh or a reconnect stored other tokens first;
 * `state` holds them), `grant_lost` (the token endpoint refused the grant),
 * `failed` (it failed for a reason that says nothing about the grant).
 */
type RefreshResult = {
    outcome: 'refreshed' | 'superseded' | 'grant_lost' | 'failed';
    state: IntegrationOAuthState;
};

/**
 * How long a refresh waits for another refresh of the same grant. Longer
 * than OAUTH_REFRESH_TIMEOUT_MS, so a waiter outlasts one slow refresh.
 */
const REFRESH_LOCK_WAIT_MS = 20_000;
/** Between two tries for the lock; a waiter holds no connection meanwhile. */
const REFRESH_LOCK_POLL_MS = 200;

/**
 * Whether two token sets are the same grant state. Both tokens count: a
 * provider may hand back the same access token while it rotates the refresh
 * token, and then only the refresh token tells that another refresh won.
 */
const sameTokens = (a?: TokenData, b?: TokenData) =>
    a?.accessToken === b?.accessToken && a?.refreshToken === b?.refreshToken;

type OAuthRepository = Repository<MCPIntegrationOAuthEntity>;

const bearerFingerprint = (accessToken: string) =>
    credentialFingerprint({ Authorization: `Bearer ${accessToken}` });

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

    /** The static-token credential a stored `auth` holds, or `null`. */
    private managedCredentialOf(
        auth: string | null | undefined,
    ): ManagedTokenCredential | null {
        const parsed = this.decryptAndParse<
            ({ kind?: string } & ManagedTokenCredential) | null
        >(auth, null);

        if (!parsed || parsed.kind !== MANAGED_TOKEN_KIND) {
            return null;
        }

        const { kind: _kind, ...credential } = parsed;
        return credential;
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
            return await this.readState(
                this.integrationOAuthRepository,
                organizationId,
                integrationId,
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
        /** Refresh even though the stated expiry has not come. */
        force?: boolean;
    }): Promise<IntegrationOAuthState> {
        const { organizationId, integrationId, oauthState, force } = params;

        const { tokens, clientId, redirectUri, asMetadata } = oauthState;

        if (
            !tokens ||
            !asMetadata?.token_endpoint ||
            !redirectUri ||
            !clientId
        ) {
            return oauthState;
        }

        const current = tokens as TokenData;
        // An expiry the provider stated, already passed, with nothing to
        // refresh it: the token is dead until the user connects again.
        const expiredForGood =
            !current.refreshToken &&
            current.expiresIn !== undefined &&
            (current.expiresAt ?? 0) < Date.now();
        if (expiredForGood) {
            return (
                await this.markGrantLost(
                    this.integrationOAuthRepository,
                    organizationId,
                    integrationId,
                    oauthState,
                )
            ).state;
        }

        if (!shouldRefreshOAuth(current, force)) {
            return oauthState;
        }

        try {
            const result = await this.withRefreshLock(
                organizationId,
                integrationId,
                (repository) =>
                    this.refreshLocked(
                        repository,
                        organizationId,
                        integrationId,
                        oauthState,
                        force,
                    ),
            );
            return result.state;
        } catch (error) {
            this.logger.error('Error checking/refreshing OAuth token:', {
                organizationId,
                integrationId,
                error,
            });
            return oauthState;
        }
    }

    /**
     * Run `work` while holding this grant's refresh lock. A rotating refresh
     * token is spent by the first refresh, so two refreshes of one grant must
     * not overlap: on several pods both read the same token, the second gets
     * `invalid_grant`, and the grant was dropped although the first had just
     * saved a new one. A caller that waited re-reads the grant inside `work`
     * and finds the new token.
     *
     * The lock is tried, not waited on: each try is its own short transaction,
     * so a waiter holds no pooled connection between tries, and only the
     * holder keeps one for its refresh. Transaction-scoped, so the lock is
     * released however `work` ends. Past REFRESH_LOCK_WAIT_MS it throws.
     */
    private async withRefreshLock<T>(
        organizationId: string,
        integrationId: string,
        work: (repository: OAuthRepository) => Promise<T>,
    ): Promise<T> {
        const key = `mcp-oauth-refresh:${organizationId}:${integrationId}`;
        const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
        for (;;) {
            const attempt =
                await this.integrationOAuthRepository.manager.transaction(
                    async (manager) => {
                        const [row] = await manager.query(
                            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
                            [key],
                        );
                        if (!row?.locked) return { locked: false as const };
                        return {
                            locked: true as const,
                            // Every read and write under the lock goes
                            // through this transaction's connection: a second
                            // pooled one per holder deadlocks a pool full of
                            // holders.
                            value: await work(
                                manager.getRepository(
                                    MCPIntegrationOAuthEntity,
                                ),
                            ),
                        };
                    },
                );
            if (attempt.locked) return attempt.value;
            if (Date.now() >= deadline) {
                throw new Error(
                    `the OAuth refresh lock was held for more than ${REFRESH_LOCK_WAIT_MS} ms`,
                );
            }
            await new Promise((resolve) =>
                setTimeout(resolve, REFRESH_LOCK_POLL_MS),
            );
        }
    }

    /**
     * Refresh the grant `oauthState` holds. Call only under the grant's
     * refresh lock: it first re-reads what is stored, and when another refresh
     * or a reconnect already stored different tokens (a rotated refresh token
     * counts) it returns those without calling the token endpoint.
     */
    private async refreshLocked(
        repository: OAuthRepository,
        organizationId: string,
        integrationId: string,
        oauthState: IntegrationOAuthState,
        force?: boolean,
    ): Promise<RefreshResult> {
        const current = oauthState.tokens as TokenData;
        const row = await repository.findOne({
            where: { integrationId, organizationId },
        });
        const storedTokens = this.decryptAndParse<IntegrationOAuthState>(
            row?.auth,
            {} as IntegrationOAuthState,
        ).tokens as TokenData | undefined;
        if (!row || !sameTokens(storedTokens, current)) {
            return {
                outcome: 'superseded',
                state: { ...oauthState, tokens: storedTokens },
            };
        }

        try {
            const newTokens = await checkAndRefreshOAuth(
                oauthState.asMetadata!.token_endpoint,
                {
                    tokens: current,
                    clientId: oauthState.clientId!,
                    clientSecret: oauthState.clientSecret,
                    redirectUri: oauthState.redirectUri!,
                    force,
                },
            );
            if (!newTokens) {
                return { outcome: 'failed', state: oauthState };
            }

            const next = { ...oauthState, tokens: newTokens };
            // Only over the row read above: a reconnect saved while the token
            // endpoint answered (it does not take this lock) is kept.
            const written = await repository.update(
                { id: row.id, auth: row.auth },
                {
                    status: MCPIntegrationOAuthStatus.ACTIVE,
                    auth: this.encryptionUtils.encrypt(JSON.stringify(next)),
                },
            );
            if (!written.affected) {
                const now = await this.readState(
                    repository,
                    organizationId,
                    integrationId,
                );
                return {
                    outcome: 'superseded',
                    state: { ...oauthState, tokens: now?.tokens },
                };
            }
            return { outcome: 'refreshed', state: next };
        } catch (error) {
            if (error instanceof OAuthGrantRejectedError) {
                const lost = await this.markGrantLost(
                    repository,
                    organizationId,
                    integrationId,
                    oauthState,
                    error.message,
                );
                return {
                    outcome: lost.lost ? 'grant_lost' : 'superseded',
                    state: lost.state,
                };
            }
            this.logger.error('Error checking/refreshing OAuth token:', {
                organizationId,
                integrationId,
                error,
            });
            return { outcome: 'failed', state: oauthState };
        }
    }

    /**
     * The MCP server refused the credential this manager handed out, though
     * by its stated expiry it was still good: the user or the provider
     * revoked it, or it was rotated elsewhere. Left alone, every review sends
     * it again and fails the same way, and the UI never asks to reconnect.
     *
     * `rejectedFingerprint` names the credential the caller sent
     * (credentialFingerprint over its auth headers). When what is stored now
     * is a different credential — refreshed or reconnected in between — the
     * refusal was about an older one and nothing changes.
     *
     * - a static token: refused for good, the user must enter a new one;
     * - OAuth: refreshed now, under the grant's refresh lock, so reports of
     *   the same refusal from several pods refresh it once and the others
     *   find the new token; refused, nothing to refresh with, or refreshed to
     *   the very token that was refused, and the grant is lost (INACTIVE,
     *   tokens dropped) until the user connects again;
     * - a refresh that fails for another reason (network, 5xx) keeps the grant.
     */
    async handleRejectedCredential(
        organizationId: string,
        integrationId: string,
        rejectedFingerprint: string,
    ): Promise<RejectedCredentialOutcome> {
        const row = await this.integrationOAuthRepository.findOne({
            where: { integrationId, organizationId },
        });
        const credential = this.managedCredentialOf(row?.auth);
        if (row && credential) {
            if (
                credentialFingerprint(renderTokenAuthHeaders(credential)) !==
                rejectedFingerprint
            ) {
                return 'stale';
            }
            // Only while the refused token is still the stored one: a token
            // the user entered in between stays usable.
            const refused = await this.integrationOAuthRepository.update(
                { id: row.id, auth: row.auth },
                { status: MCPIntegrationOAuthStatus.INACTIVE },
            );
            return refused.affected ? 'token_rejected' : 'stale';
        }

        const current = this.decryptAndParse<IntegrationOAuthState>(
            row?.auth,
            {} as IntegrationOAuthState,
        ).tokens as TokenData | undefined;
        if (!current?.accessToken) return 'stale';
        if (bearerFingerprint(current.accessToken) !== rejectedFingerprint) {
            return 'stale';
        }

        try {
            return await this.withRefreshLock(
                organizationId,
                integrationId,
                (repository) =>
                    this.refreshRejectedGrant(
                        repository,
                        organizationId,
                        integrationId,
                        rejectedFingerprint,
                    ),
            );
        } catch (error) {
            this.logger.error('Could not refresh a refused OAuth grant', {
                organizationId,
                integrationId,
                error,
            });
            return 'kept';
        }
    }

    /** The OAuth half of handleRejectedCredential, under the refresh lock. */
    private async refreshRejectedGrant(
        repository: OAuthRepository,
        organizationId: string,
        integrationId: string,
        rejectedFingerprint: string,
    ): Promise<RejectedCredentialOutcome> {
        // Re-read under the lock: a report of the same refusal from another
        // pod may have refreshed the grant while this one waited.
        const oauthState = await this.readState(
            repository,
            organizationId,
            integrationId,
        );
        const current = oauthState?.tokens as TokenData | undefined;
        if (
            !oauthState ||
            !current?.accessToken ||
            bearerFingerprint(current.accessToken) !== rejectedFingerprint
        ) {
            return 'stale';
        }

        const canRefresh =
            !!current.refreshToken &&
            !!oauthState.asMetadata?.token_endpoint &&
            !!oauthState.redirectUri &&
            !!oauthState.clientId;
        if (!canRefresh) {
            const lost = await this.markGrantLost(
                repository,
                organizationId,
                integrationId,
                oauthState,
                'the MCP server refused the access token and there is no refresh token',
            );
            return lost.lost ? 'grant_lost' : 'stale';
        }

        const result = await this.refreshLocked(
            repository,
            organizationId,
            integrationId,
            oauthState,
            true,
        );
        switch (result.outcome) {
            case 'refreshed': {
                const next = result.state.tokens as TokenData;
                if (next.accessToken !== current.accessToken) {
                    return 'refreshed';
                }
                // The provider handed back the very token the MCP server
                // refused: sending it again fails the same way.
                const lost = await this.markGrantLost(
                    repository,
                    organizationId,
                    integrationId,
                    result.state,
                    'the MCP server refused the access token and refreshing returned the same one',
                );
                return lost.lost ? 'grant_lost' : 'stale';
            }
            case 'grant_lost':
                return 'grant_lost';
            case 'superseded':
                return 'stale';
            case 'failed':
                return 'kept';
        }
    }

    /**
     * The grant can no longer be refreshed: mark it INACTIVE (the UI then asks
     * the user to connect again) and stop handing out its token. Connecting
     * again saves a fresh ACTIVE grant.
     *
     * Only while the stored tokens are still the ones in `oauthState`, in the
     * same statement: a refresh or a reconnect that stored others in between
     * (a rotated refresh token counts) keeps them, and that state is returned
     * with `lost: false`.
     */
    private async markGrantLost(
        repository: OAuthRepository,
        organizationId: string,
        integrationId: string,
        oauthState: IntegrationOAuthState,
        reason = 'access token expired and there is no refresh token',
    ): Promise<{ lost: boolean; state: IntegrationOAuthState }> {
        const row = await repository.findOne({
            where: { integrationId, organizationId },
        });
        const storedTokens = this.decryptAndParse<IntegrationOAuthState>(
            row?.auth,
            {} as IntegrationOAuthState,
        ).tokens as TokenData | undefined;
        if (
            !row ||
            !sameTokens(
                storedTokens,
                oauthState.tokens as TokenData | undefined,
            )
        ) {
            return {
                lost: false,
                state: { ...oauthState, tokens: storedTokens },
            };
        }

        // Drop the tokens too: other read paths (custom integrations'
        // getValidAccessToken) read the stored state without its status.
        const lost = { ...oauthState, tokens: undefined };
        const written = await repository.update(
            { id: row.id, auth: row.auth },
            {
                status: MCPIntegrationOAuthStatus.INACTIVE,
                auth: this.encryptionUtils.encrypt(JSON.stringify(lost)),
            },
        );
        if (!written.affected) {
            const now = await this.readState(
                repository,
                organizationId,
                integrationId,
            );
            return {
                lost: false,
                state: { ...oauthState, tokens: now?.tokens },
            };
        }

        this.logger.warn(
            'OAuth grant lost; the integration must be connected again',
            {
                organizationId,
                integrationId,
                reason,
            },
        );
        return { lost: true, state: lost };
    }

    /**
     * The stored OAuth state, read through `repository`: the shared one, or
     * the refresh lock's transaction repository for reads under the lock.
     */
    private async readState(
        repository: OAuthRepository,
        organizationId: string,
        integrationId: string,
    ): Promise<IntegrationOAuthState | null> {
        const row = await repository.findOne({
            where: { integrationId, organizationId },
        });
        if (!row?.auth) return null;
        return this.decryptAndParse<IntegrationOAuthState>(
            row.auth,
            {} as IntegrationOAuthState,
        );
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

            return this.managedCredentialOf(entity?.auth);
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

        const status = await this.getOAuthStatus(organizationId, integrationId);
        if (status === MCPIntegrationOAuthStatus.INACTIVE) {
            return {};
        }

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
