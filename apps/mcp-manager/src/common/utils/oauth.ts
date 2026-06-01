import axios, { AxiosResponse } from 'axios';
import { createHash, randomBytes } from 'crypto';

export function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

export function generateState() {
    return randomBytes(16).toString('hex');
}

export function getCanonicalResourceUri(baseUrl: string): string {
    const url = new URL(baseUrl);
    const scheme = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : '';
    const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
    const canonical = `${scheme}//${host}${port}${path}`;
    return canonical.endsWith('/') && path ? canonical.slice(0, -1) : canonical;
}

export function buildWellKnownUrl(base: string, wellKnownName: string): string {
    const u = new URL(base);
    const origin = u.origin;
    const basePath = u.pathname && u.pathname !== '/' ? u.pathname : '';
    const wellKnownPath = `/.well-known/${wellKnownName}${basePath}`;
    return new URL(wellKnownPath, origin).toString();
}

export async function discoverOAuth(baseUrl: string) {
    let rsMetadataUrl = buildWellKnownUrl(baseUrl, 'oauth-protected-resource');
    let rsResp = await axios.get<OAuthProtectedResourceMetadata>(
        rsMetadataUrl,
        {
            validateStatus: () => true,
        },
    );
    if (rsResp.status >= 400) {
        console.error(
            `Error accessing ${rsMetadataUrl}, code: ${rsResp.status}, attempting with root url`,
        );

        rsMetadataUrl = buildWellKnownUrl(
            new URL(baseUrl).origin,
            'oauth-protected-resource',
        );

        rsResp = await axios.get(rsMetadataUrl, {
            validateStatus: () => true,
        });

        if (rsResp.status >= 400) {
            console.error(
                `Error accessing ${rsMetadataUrl}, code: ${rsResp.status}, attempting to proceed without`,
            );
        }
    }

    const rs = rsResp.data || ({} as OAuthProtectedResourceMetadata);
    const authorizationServers = rs.authorization_servers || [];
    if (
        rsResp.status < 400 &&
        (!authorizationServers || authorizationServers.length === 0)
    ) {
        throw new Error('authorization_servers not found in resource metadata');
    }

    let asIssuer = authorizationServers?.[0] || baseUrl;
    let asWellKnown = buildWellKnownUrl(asIssuer, 'oauth-authorization-server');
    let asResp = await axios.get<OAuthAuthorizationServerMetadata>(
        asWellKnown,
        {
            validateStatus: () => true,
        },
    );
    if (asResp.status >= 400) {
        console.error(
            `Error accessing ${asWellKnown}, status: ${asResp.status}, attempting with baseUrl`,
        );

        asIssuer = baseUrl;
        asWellKnown = buildWellKnownUrl(asIssuer, 'oauth-authorization-server');
        asResp = await axios.get(asWellKnown, {
            validateStatus: () => true,
        });

        if (asResp.status >= 400) {
            console.error(
                `Error accessing ${asWellKnown}, status: ${asResp.status}, attempting with root url`,
            );

            asIssuer = new URL(baseUrl).origin;
            asWellKnown = buildWellKnownUrl(
                asIssuer,
                'oauth-authorization-server',
            );
            asResp = await axios.get(asWellKnown, {
                validateStatus: () => true,
            });

            if (asResp.status >= 400) {
                throw new Error(
                    'Failed to fetch authorization server metadata',
                );
            }
        }
    }
    const as = asResp.data || ({} as OAuthAuthorizationServerMetadata);

    return {
        rs,
        as,
    };
}

export async function registerOauthClient(
    registrationEndpoint: string,
    redirectUri: string,
    oauthScopes: string[],
): Promise<{ clientId: string; clientSecret: string | undefined }> {
    const registrationBody: any = {
        client_name: 'Kodus MCP Manager',
        client_uri: 'https://kodus.io',
        logo_uri:
            'https://kodus.io/wp-content/uploads/2025/11/Kodus-AI-Logo-6.png',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(oauthScopes?.length > 0 ? { scope: oauthScopes.join(' ') } : {}),
    };

    const regResp = await axios.post(registrationEndpoint, registrationBody, {
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
    });

    if (regResp.status >= 400) {
        throw new Error(
            `Client registration failed, status: ${regResp.status}: statusText: ${regResp.statusText}`,
        );
    }

    const client = regResp.data || {};
    const clientId: string = client.client_id;
    const clientSecret: string | undefined = client.client_secret;

    if (!clientId) {
        throw new Error('Client registration did not return client_id');
    }

    return { clientId, clientSecret };
}

export function buildAuthorizationUrl(params: {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
    baseUrl: string;
    oauthScopes: string[];
}): string {
    const {
        authorizationEndpoint,
        clientId,
        redirectUri,
        challenge,
        state,
        baseUrl,
        oauthScopes,
    } = params;

    const resource = getCanonicalResourceUri(baseUrl);
    const searchParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
        state,
        ...(oauthScopes?.length > 0 ? { scope: oauthScopes.join(' ') } : {}),
    });

    return `${authorizationEndpoint}?${searchParams.toString()}`;
}

export interface OAuthAuthorizationServerMetadata {
    // REQUIRED
    issuer: string;

    // OPTIONAL BUT COMMON
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    jwks_uri?: string;
    scopes_supported?: string[];
    response_types_supported?: string[];
    response_modes_supported?: string[];
    grant_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    token_endpoint_auth_signing_alg_values_supported?: string[];
    service_documentation?: string;
    ui_locales_supported?: string[];
    op_policy_uri?: string;
    op_tos_uri?: string;

    // PKCE
    code_challenge_methods_supported?: string[];

    // OIDC-related (if the server also supports OpenID Connect)
    subject_types_supported?: string[];
    id_token_signing_alg_values_supported?: string[];
    id_token_encryption_alg_values_supported?: string[];
    id_token_encryption_enc_values_supported?: string[];
    userinfo_endpoint?: string;
    userinfo_signing_alg_values_supported?: string[];
    userinfo_encryption_alg_values_supported?: string[];
    userinfo_encryption_enc_values_supported?: string[];

    // Introspection / Revocation
    introspection_endpoint?: string;
    introspection_endpoint_auth_methods_supported?: string[];
    revocation_endpoint?: string;
    revocation_endpoint_auth_methods_supported?: string[];

    // CORS & Misc
    claim_types_supported?: string[];
    claims_supported?: string[];
    claims_locales_supported?: string[];

    // Catch-all for future extensions
    [key: string]: unknown;
}

export interface OAuthProtectedResourceMetadata {
    // REQUIRED
    resource: string;

    // OPTIONAL
    authorization_servers?: string[];
    jwks_uri?: string;

    // Token introspection / validation
    introspection_endpoint?: string;
    introspection_endpoint_auth_methods_supported?: string[];
    introspection_endpoint_auth_signing_alg_values_supported?: string[];

    // Revocation
    revocation_endpoint?: string;
    revocation_endpoint_auth_methods_supported?: string[];

    // MTLS / DPoP
    dpop_signing_alg_values_supported?: string[];
    mtls_endpoint_aliases?: {
        [key: string]: string;
    };

    // Misc / extensions
    signing_alg_values_supported?: string[];
    encryption_alg_values_supported?: string[];
    encryption_enc_values_supported?: string[];

    // Allow future spec extensions
    [key: string]: unknown;
}

export async function exchangeCodeForTokens(
    endpoint: string,
    params: {
        clientId: string;
        clientSecret?: string;
        code: string;
        redirectUri: string;
        codeVerifier: string;
        resource: string;
        state: string;
    },
) {
    const {
        clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier,
        resource,
        state,
    } = params;

    const body = new URLSearchParams({
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource,
        state,
    });

    const tokenResp = await axios.post(endpoint, body.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
    });

    if (tokenResp.status >= 400) {
        throw new Error('OAuth token exchange failed');
    }

    const parsedTokens = parseTokenResponse(tokenResp);

    return parsedTokens;
}

export async function checkAndRefreshOAuth(
    endpoint: string,
    params: {
        tokens: TokenData;
        clientId: string;
        clientSecret?: string;
        redirectUri: string;
    },
) {
    const { tokens, clientId, clientSecret, redirectUri } = params;

    const now = Date.now();
    const { expiresAt, refreshToken } = tokens;

    if (expiresAt < now + 5 * 60 * 1000 && refreshToken) {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
            ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        });

        const tokenResp = await axios.post(endpoint, body.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            validateStatus: () => true,
        });

        if (tokenResp.status >= 400) {
            throw new Error('Failed to refresh tokens');
        }

        const tokens = parseTokenResponse(tokenResp);

        return tokens;
    }
}

export interface TokenData {
    accessToken: string;
    tokenType?: string;
    receivedAt?: number;
    expiresIn?: number;
    expiresAt?: number;
    refreshToken?: string;
    scope?: string;
}

function parseTokenResponse(response: AxiosResponse): TokenData {
    const tokenSet = response.data || {};
    let parsedTokens = tokenSet;

    if (typeof tokenSet === 'string') {
        try {
            parsedTokens = JSON.parse(tokenSet);
        } catch (error) {
            parsedTokens = {};
            const accessMatch = tokenSet.match(/(?:^|&)access_token=([^&]+)/);
            if (accessMatch) {
                parsedTokens['access_token'] = decodeURIComponent(
                    accessMatch[1],
                );
            }
            const refreshMatch = tokenSet.match(/(?:^|&)refresh_token=([^&]+)/);
            if (refreshMatch) {
                parsedTokens['refresh_token'] = decodeURIComponent(
                    refreshMatch[1],
                );
            }
            const tokenTypeMatch = tokenSet.match(/(?:^|&)token_type=([^&]+)/);
            if (tokenTypeMatch) {
                parsedTokens['token_type'] = decodeURIComponent(
                    tokenTypeMatch[1],
                );
            }
            const expiresMatch = tokenSet.match(/(?:^|&)expires_in=([^&]+)/);
            if (expiresMatch) {
                const n = Number(expiresMatch[1]);
                parsedTokens['expires_in'] = Number.isNaN(n) ? undefined : n;
            }
            const scopeMatch = tokenSet.match(/(?:^|&)scope=([^&]+)/);
            if (scopeMatch) {
                parsedTokens['scope'] = decodeURIComponent(scopeMatch[1]);
            }
        }
    }

    if (!parsedTokens.access_token) {
        throw new Error('Access token not found in response');
    }

    const receivedAt = Date.now();
    const expiresAt = receivedAt + (parsedTokens.expires_in || 0) * 1000;

    return {
        accessToken: parsedTokens.access_token,
        tokenType: parsedTokens.token_type,
        receivedAt,
        expiresIn: parsedTokens.expires_in,
        expiresAt,
        refreshToken: parsedTokens.refresh_token,
        scope: parsedTokens.scope,
    };
}
