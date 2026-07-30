import {
    defaultAuthBlock,
    getAuthMethod,
    ManagedAuthMethod,
    normalizeAuthMethods,
    resolveAuthMethodEnv,
} from '../../src/modules/providers/kodusMCP/auth-methods';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

describe('normalizeAuthMethods', () => {
    it('wraps a legacy single none auth block into one default method', () => {
        const methods = normalizeAuthMethods({
            auth: { type: MCPIntegrationAuthType.NONE },
        });

        expect(methods).toEqual([
            { id: 'none', type: MCPIntegrationAuthType.NONE, default: true },
        ]);
    });

    it('wraps a legacy oauth2 block, preserving its unique fields', () => {
        const methods = normalizeAuthMethods({
            auth: {
                type: MCPIntegrationAuthType.OAUTH2,
                dynamicRegistration: true,
            },
        });

        expect(methods).toEqual([
            {
                id: 'oauth2',
                type: MCPIntegrationAuthType.OAUTH2,
                dynamicRegistration: true,
                default: true,
            },
        ]);
    });

    it('defaults to a single none method when neither auth nor authMethods is present', () => {
        const methods = normalizeAuthMethods({});

        expect(methods).toEqual([
            { id: 'none', type: MCPIntegrationAuthType.NONE, default: true },
        ]);
    });

    it('passes through an explicit authMethods array and marks the first as default', () => {
        const methods = normalizeAuthMethods({
            authMethods: [
                {
                    id: 'oauth',
                    label: 'OAuth',
                    type: MCPIntegrationAuthType.OAUTH2,
                    dynamicRegistration: true,
                },
                {
                    id: 'token',
                    label: 'API token',
                    type: MCPIntegrationAuthType.BASIC,
                    userFields: [
                        { name: 'email', required: true },
                        { name: 'apiToken', required: true, secret: true },
                        { name: 'cloudId', required: true },
                    ],
                },
            ],
        });

        expect(methods).toHaveLength(2);
        expect(methods[0]).toMatchObject({ id: 'oauth', default: true });
        expect(methods[1]).toMatchObject({ id: 'token' });
        expect(methods[1].default).toBeFalsy();
    });

    it('respects an explicitly flagged default rather than forcing the first', () => {
        const methods = normalizeAuthMethods({
            authMethods: [
                { id: 'token', type: MCPIntegrationAuthType.BEARER_TOKEN },
                {
                    id: 'oauth',
                    type: MCPIntegrationAuthType.OAUTH2,
                    default: true,
                },
            ],
        });

        expect(methods.find((m) => m.default)?.id).toBe('oauth');
        expect(methods.filter((m) => m.default)).toHaveLength(1);
    });

    it('derives an id from the type when an authMethods entry omits one', () => {
        const methods = normalizeAuthMethods({
            authMethods: [{ type: MCPIntegrationAuthType.BEARER_TOKEN }],
        });

        expect(methods[0].id).toBe('bearer_token');
    });
});

describe('getAuthMethod', () => {
    const methods: ManagedAuthMethod[] = [
        { id: 'oauth', type: MCPIntegrationAuthType.OAUTH2, default: true },
        { id: 'token', type: MCPIntegrationAuthType.BASIC },
    ];

    it('returns the requested method by id', () => {
        expect(getAuthMethod(methods, 'token')?.id).toBe('token');
    });

    it('returns the default method when no id is given', () => {
        expect(getAuthMethod(methods)?.id).toBe('oauth');
    });

    it('returns undefined for an unknown id', () => {
        expect(getAuthMethod(methods, 'nope')).toBeUndefined();
    });
});

describe('defaultAuthBlock', () => {
    it('collapses the default oauth method into a legacy auth block', () => {
        const methods = normalizeAuthMethods({
            authMethods: [
                {
                    id: 'oauth',
                    label: 'OAuth',
                    type: MCPIntegrationAuthType.OAUTH2,
                    dynamicRegistration: true,
                    default: true,
                },
                {
                    id: 'token',
                    type: MCPIntegrationAuthType.BASIC,
                    userFields: [{ name: 'apiToken', secret: true }],
                },
            ],
        });

        expect(defaultAuthBlock(methods)).toEqual({
            type: MCPIntegrationAuthType.OAUTH2,
            dynamicRegistration: true,
        });
    });

    it('round-trips a legacy single-auth entry through normalize + collapse', () => {
        const methods = normalizeAuthMethods({
            auth: {
                type: MCPIntegrationAuthType.OAUTH2,
                dynamicRegistration: true,
            },
        });

        expect(defaultAuthBlock(methods)).toEqual({
            type: MCPIntegrationAuthType.OAUTH2,
            dynamicRegistration: true,
        });
    });
});

describe('resolveAuthMethodEnv', () => {
    it('fills client id/secret from the named env vars', () => {
        const method: ManagedAuthMethod = {
            id: 'oauth',
            type: MCPIntegrationAuthType.OAUTH2,
            dynamicRegistration: false,
            clientIdEnv: 'CLICKUP_CLIENT_ID',
            clientSecretEnv: 'CLICKUP_CLIENT_SECRET',
        };

        const resolved = resolveAuthMethodEnv(method, {
            CLICKUP_CLIENT_ID: 'cid-123',
            CLICKUP_CLIENT_SECRET: 'secret-xyz',
        });

        expect(resolved.clientId).toBe('cid-123');
        expect(resolved.clientSecret).toBe('secret-xyz');
    });

    it('leaves client creds undefined when env vars are unset (pre-approval scaffold)', () => {
        const method: ManagedAuthMethod = {
            id: 'oauth',
            type: MCPIntegrationAuthType.OAUTH2,
            dynamicRegistration: false,
            clientIdEnv: 'CLICKUP_CLIENT_ID',
        };

        const resolved = resolveAuthMethodEnv(method, {});

        expect(resolved.clientId).toBeUndefined();
    });

    it('passes through methods that name no env vars', () => {
        const method: ManagedAuthMethod = {
            id: 'oauth',
            type: MCPIntegrationAuthType.OAUTH2,
            dynamicRegistration: true,
        };

        expect(resolveAuthMethodEnv(method, {})).toBe(method);
    });
});
