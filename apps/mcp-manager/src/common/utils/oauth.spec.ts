import axios from 'axios';

import {
    authorizationServerMetadataUrls,
    discoverOAuth,
    buildAuthorizationUrl,
    exchangeCodeForTokens,
} from './oauth';

jest.mock('axios');

describe('authorizationServerMetadataUrls', () => {
    it('lists OAuth and OpenID discovery, path inserted then appended', () => {
        expect(
            authorizationServerMetadataUrls(
                'https://login.microsoftonline.com/tenant-1/v2.0',
            ),
        ).toEqual([
            'https://login.microsoftonline.com/.well-known/oauth-authorization-server/tenant-1/v2.0',
            'https://login.microsoftonline.com/.well-known/openid-configuration/tenant-1/v2.0',
            'https://login.microsoftonline.com/tenant-1/v2.0/.well-known/openid-configuration',
        ]);
        expect(
            authorizationServerMetadataUrls('https://auth.example.com/'),
        ).toEqual([
            'https://auth.example.com/.well-known/oauth-authorization-server',
            'https://auth.example.com/.well-known/openid-configuration',
        ]);
    });
});

describe('discoverOAuth', () => {
    const get = axios.get as jest.Mock;
    beforeEach(() => get.mockReset());

    it('finds an issuer that publishes only OpenID Connect metadata (Microsoft Entra)', async () => {
        const issuer = 'https://login.microsoftonline.com/tenant-1/v2.0';
        get.mockImplementation(async (url: string) => {
            if (
                url ===
                'https://mcp.example.com/.well-known/oauth-protected-resource/org'
            ) {
                return {
                    status: 200,
                    data: {
                        resource: 'https://mcp.example.com/org',
                        authorization_servers: [issuer],
                    },
                };
            }
            if (url === `${issuer}/.well-known/openid-configuration`) {
                return {
                    status: 200,
                    data: {
                        issuer,
                        authorization_endpoint: `${issuer}/authorize`,
                    },
                };
            }
            return { status: 404, data: {} };
        });

        const { as } = await discoverOAuth('https://mcp.example.com/org');

        expect(as.authorization_endpoint).toBe(`${issuer}/authorize`);
    });

    it('still fails when no metadata URL answers', async () => {
        get.mockResolvedValue({ status: 404, data: {} });
        await expect(
            discoverOAuth('https://mcp.example.com/org'),
        ).rejects.toThrow('Failed to fetch authorization server metadata');
    });
});

describe('exchangeCodeForTokens', () => {
    it("says why the token endpoint refused, without the request's secrets", async () => {
        (axios.post as jest.Mock).mockResolvedValue({
            status: 400,
            data: {
                error: 'invalid_client',
                error_description:
                    'AADSTS7000218: The request body must contain client_secret.\r\nTrace ID: x',
            },
        });
        const failure = exchangeCodeForTokens('https://login.example/token', {
            clientId: 'client-1',
            clientSecret: 'secret-value',
            code: 'code-value',
            redirectUri: 'http://localhost:3000/setup/mcp/oauth',
            codeVerifier: 'verifier',
            resource: 'https://mcp.example.com/org',
            state: 'state',
        });
        await expect(failure).rejects.toThrow(
            'OAuth token exchange failed: status 400 · invalid_client · AADSTS7000218',
        );
        await expect(failure).rejects.not.toThrow(/secret-value|code-value/);
    });
});

describe('the RFC 8707 resource parameter', () => {
    const params = {
        clientId: 'client-1',
        code: 'code',
        redirectUri: 'http://localhost:3000/setup/mcp/oauth',
        codeVerifier: 'verifier',
        resource: 'https://mcp.dev.azure.com/acme',
        state: 'state',
    };
    const post = axios.post as jest.Mock;
    const sentResource = (call: number) =>
        new URLSearchParams(post.mock.calls[call][1]).get('resource');
    beforeEach(() => post.mockReset());

    it('is sent on the authorization request and the first token request', async () => {
        const url = new URL(
            buildAuthorizationUrl({
                authorizationEndpoint: 'https://auth.example.com/authorize',
                clientId: 'client-1',
                redirectUri: params.redirectUri,
                challenge: 'challenge',
                state: 'state',
                baseUrl: 'https://mcp.dev.azure.com/acme',
                oauthScopes: [],
            }),
        );
        expect(url.searchParams.get('resource')).toBe(
            'https://mcp.dev.azure.com/acme',
        );

        post.mockResolvedValue({
            status: 200,
            data: { access_token: 'token' },
        });
        await exchangeCodeForTokens('https://auth.example.com/token', params);
        expect(post).toHaveBeenCalledTimes(1);
        expect(sentResource(0)).toBe('https://mcp.dev.azure.com/acme');
    });

    it('is dropped once when the server refuses it as invalid_target (Microsoft Entra)', async () => {
        post.mockResolvedValueOnce({
            status: 400,
            data: {
                error: 'invalid_target',
                error_description: 'AADSTS9010010',
            },
        });
        post.mockResolvedValueOnce({
            status: 200,
            data: { access_token: 'token' },
        });

        await expect(
            exchangeCodeForTokens('https://login.example/token', params),
        ).resolves.toMatchObject({ accessToken: 'token' });
        expect(sentResource(0)).toBe('https://mcp.dev.azure.com/acme');
        expect(sentResource(1)).toBeNull();
    });

    it('is not retried for any other refusal', async () => {
        post.mockResolvedValue({
            status: 400,
            data: { error: 'invalid_grant' },
        });
        await expect(
            exchangeCodeForTokens('https://login.example/token', params),
        ).rejects.toThrow('invalid_grant');
        expect(post).toHaveBeenCalledTimes(1);
    });
});
