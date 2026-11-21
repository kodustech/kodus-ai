/**
 * A refused MCP credential against a real Postgres, with two "pods" (two
 * pools, two service instances) and a token endpoint that rotates its refresh
 * token. Each pod dedupes its own reports only, so the same refusal reaches
 * the manager from several pods at once; with a rotating refresh token the
 * second refresh is refused, and that must not drop the grant the first one
 * just saved. A reconnect that lands while a refusal is handled must stay
 * ACTIVE too.
 *
 * Runs in CI against the tests job's Postgres (credentials from .env); locally
 * with TEST_PG_* pointing at any Postgres. Each run works in its own database.
 */
require('dotenv').config();

jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { DataSource } from 'typeorm';

import { credentialFingerprint } from '@libs/mcp-server/credential-fingerprint';

import { EncryptionUtils } from '../../src/common/utils/encryption';
import { MCPIntegrationOAuthEntity } from '../../src/modules/integrations/entities/mcp-integration-oauth.entity';
import {
    MCPIntegrationAuthType,
    MCPIntegrationOAuthStatus,
} from '../../src/modules/integrations/enums/integration.enum';
import { IntegrationOAuthService } from '../../src/modules/integrations/integration-oauth.service';
import {
    MCPConnectionEntity,
    MCPConnectionStatus,
} from '../../src/modules/mcp/entities/mcp-connection.entity';
import { McpService } from '../../src/modules/mcp/mcp.service';

const PG = {
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: Number(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? 5432,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
};
const TEST_DB = `mcp_refresh_race_it_${process.pid}_${Date.now()}`;
const ORG = 'org-it';
const INT = 'linear-default';

const bearer = (token: string) =>
    credentialFingerprint({ Authorization: `Bearer ${token}` })!;

const config = {
    get: (key: string) =>
        key === 'encryption.secret' ? 'it-encryption-secret' : undefined,
} as any;

/** A token endpoint whose refresh tokens work once (RFC 6749 §10.4 rotation). */
function rotatingTokenEndpoint() {
    let live = 'r1';
    let issued = 1;
    // sameAccess: the endpoint hands back the access token it already issued
    // and rotates only the refresh token.
    const state = {
        calls: 0,
        refuseAll: false,
        sameAccess: false,
        // Runs while the endpoint is answering, before it replies.
        duringRefresh: undefined as undefined | (() => Promise<unknown>),
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            state.calls++;
            const presented = new URLSearchParams(body).get('refresh_token');
            const during = state.duringRefresh?.() ?? Promise.resolve();
            // Slow enough that two concurrent refreshes overlap.
            setTimeout(async () => {
                await during;
                res.setHeader('Content-Type', 'application/json');
                if (state.refuseAll || presented !== live) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'invalid_grant' }));
                    return;
                }
                issued++;
                live = `r${issued}`;
                res.end(
                    JSON.stringify({
                        access_token: state.sameAccess ? 'a1' : `a${issued}`,
                        refresh_token: live,
                        expires_in: 3600,
                    }),
                );
            }, 300);
        });
    });
    return { server, state };
}

async function postgresReachable(): Promise<boolean> {
    const probe = new DataSource({ type: 'postgres', ...PG });
    try {
        await probe.initialize();
        await probe.destroy();
        return true;
    } catch {
        return false;
    }
}

const skip = process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)(
    'refused MCP credential across pods (real Postgres)',
    () => {
        let admin: DataSource;
        const pods: DataSource[] = [];
        let endpoint: ReturnType<typeof rotatingTokenEndpoint>;
        let tokenUrl: string;

        const pod = async () => {
            const ds = new DataSource({
                type: 'postgres',
                ...PG,
                database: TEST_DB,
                entities: [MCPIntegrationOAuthEntity, MCPConnectionEntity],
            });
            await ds.initialize();
            pods.push(ds);
            const oauth = new IntegrationOAuthService(
                config,
                ds.getRepository(MCPIntegrationOAuthEntity),
                new EncryptionUtils(config),
            );
            const mcp = new McpService(
                {} as any,
                ds.getRepository(MCPConnectionEntity),
                {} as any,
                config,
                oauth,
            );
            return { ds, oauth, mcp };
        };

        const connectionStatus = async (ds: DataSource) =>
            (
                await ds.getRepository(MCPConnectionEntity).findOneByOrFail({
                    organizationId: ORG,
                    integrationId: INT,
                })
            ).status;

        beforeAll(async () => {
            if (!(await postgresReachable())) {
                // CI provides Postgres: an unreachable one there is a broken
                // setup, not a reason to pass without running.
                if (process.env.CI) throw new Error('Postgres unreachable');
                return;
            }
            admin = new DataSource({ type: 'postgres', ...PG });
            await admin.initialize();
            await admin.query(`CREATE DATABASE "${TEST_DB}"`);
            const setup = new DataSource({
                type: 'postgres',
                ...PG,
                database: TEST_DB,
            });
            await setup.initialize();
            await setup.query('CREATE SCHEMA "mcp-manager"');
            await setup.destroy();
            const schema = new DataSource({
                type: 'postgres',
                ...PG,
                database: TEST_DB,
                entities: [MCPIntegrationOAuthEntity, MCPConnectionEntity],
                synchronize: true,
            });
            await schema.initialize();
            await schema.destroy();
        }, 60_000);

        beforeEach(async () => {
            endpoint = rotatingTokenEndpoint();
            await new Promise<void>((resolve) =>
                endpoint.server.listen(0, '127.0.0.1', resolve),
            );
            const { port } = endpoint.server.address() as AddressInfo;
            tokenUrl = `http://127.0.0.1:${port}/token`;
        });

        afterEach(async () => {
            await new Promise((resolve) => endpoint.server.close(resolve));
            await Promise.all(pods.splice(0).map((ds) => ds.destroy()));
            if (admin) {
                const ds = new DataSource({
                    type: 'postgres',
                    ...PG,
                    database: TEST_DB,
                });
                await ds.initialize();
                await ds.query(
                    'DELETE FROM "mcp-manager"."mcp_integration_oauth"',
                );
                await ds.query('DELETE FROM "mcp-manager"."mcp_connections"');
                await ds.destroy();
            }
        });

        afterAll(async () => {
            if (!admin) return;
            await admin.query(
                `DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`,
            );
            await admin.destroy();
        });

        const seed = async (
            pod: Awaited<ReturnType<typeof pod>>,
            tokens: Record<string, unknown>,
        ) => {
            await pod.oauth.saveOAuthState(
                ORG,
                INT,
                MCPIntegrationOAuthStatus.ACTIVE,
                {
                    clientId: 'client-it',
                    redirectUri: 'https://app.example.test/callback',
                    asMetadata: { token_endpoint: tokenUrl },
                    tokens: {
                        accessToken: 'a1',
                        refreshToken: 'r1',
                        expiresIn: 3600,
                        expiresAt: Date.now() + 3_600_000,
                        ...tokens,
                    },
                } as any,
            );
            await activeConnection(pod.ds);
        };

        const activeConnection = (ds: DataSource) =>
            ds.getRepository(MCPConnectionEntity).save({
                organizationId: ORG,
                integrationId: INT,
                provider: 'kodusmcp',
                status: MCPConnectionStatus.ACTIVE,
                appName: 'linear',
                allowedTools: [],
            });

        it('two pods reporting the same refused token refresh it once, and the grant and connection stay usable', async () => {
            if (!admin) return;
            const a = await pod();
            const b = await pod();
            await seed(a, {});

            const outcomes = await Promise.all([
                a.mcp.handleRejectedKodusMcpCredential(ORG, INT, bearer('a1')),
                b.mcp.handleRejectedKodusMcpCredential(ORG, INT, bearer('a1')),
            ]);

            expect(outcomes.map((o) => o.outcome).sort()).toEqual([
                'refreshed',
                'stale',
            ]);
            expect(endpoint.state.calls).toBe(1);
            expect(await a.oauth.getOAuthStatus(ORG, INT)).toBe(
                MCPIntegrationOAuthStatus.ACTIVE,
            );
            expect(await b.oauth.resolveManagedAuthHeaders(ORG, INT)).toEqual({
                Authorization: 'Bearer a2',
            });
            expect(
                ((await a.oauth.getOAuthState(ORG, INT))?.tokens as any)
                    .refreshToken,
            ).toBe('r2');
            expect(await connectionStatus(a.ds)).toBe(
                MCPConnectionStatus.ACTIVE,
            );
        });

        it('two pods refreshing an expiring token at once refresh it once', async () => {
            if (!admin) return;
            const a = await pod();
            const b = await pod();
            await seed(a, { expiresAt: Date.now() + 60_000 });

            const headers = await Promise.all([
                a.oauth.resolveManagedAuthHeaders(ORG, INT),
                b.oauth.resolveManagedAuthHeaders(ORG, INT),
            ]);

            expect(headers).toEqual([
                { Authorization: 'Bearer a2' },
                { Authorization: 'Bearer a2' },
            ]);
            expect(endpoint.state.calls).toBe(1);
            expect(await a.oauth.getOAuthStatus(ORG, INT)).toBe(
                MCPIntegrationOAuthStatus.ACTIVE,
            );
        });

        it('a refresh that rotates only the refresh token is not taken for a lost grant by the pod that waited', async () => {
            if (!admin) return;
            const a = await pod();
            const b = await pod();
            await seed(a, { expiresAt: Date.now() + 60_000 });
            endpoint.state.sameAccess = true;

            const headers = await Promise.all([
                a.oauth.resolveManagedAuthHeaders(ORG, INT),
                b.oauth.resolveManagedAuthHeaders(ORG, INT),
            ]);

            expect(headers).toEqual([
                { Authorization: 'Bearer a1' },
                { Authorization: 'Bearer a1' },
            ]);
            expect(endpoint.state.calls).toBe(1);
            expect(await a.oauth.getOAuthStatus(ORG, INT)).toBe(
                MCPIntegrationOAuthStatus.ACTIVE,
            );
            expect(
                ((await a.oauth.getOAuthState(ORG, INT))?.tokens as any)
                    .refreshToken,
            ).toBe('r2');
        });

        it('a reconnect saved while a refresh is in flight is kept', async () => {
            if (!admin) return;
            const a = await pod();
            await seed(a, { expiresAt: Date.now() + 60_000 });
            endpoint.state.duringRefresh = () =>
                a.oauth.saveOAuthState(
                    ORG,
                    INT,
                    MCPIntegrationOAuthStatus.ACTIVE,
                    {
                        clientId: 'client-reconnected',
                        redirectUri:
                            'https://app.example.test/callback-reconnected',
                        asMetadata: { token_endpoint: tokenUrl },
                        tokens: {
                            accessToken: 'reconnected',
                            refreshToken: 'reconnected-refresh',
                            expiresIn: 3600,
                            expiresAt: Date.now() + 3_600_000,
                        },
                    } as any,
                );

            expect(await a.oauth.resolveManagedAuthHeaders(ORG, INT)).toEqual({
                Authorization: 'Bearer reconnected',
            });
            const stored = await a.oauth.getOAuthState(ORG, INT);
            expect(stored).toMatchObject({
                clientId: 'client-reconnected',
                redirectUri: 'https://app.example.test/callback-reconnected',
            });
            expect(stored?.tokens).toMatchObject({
                accessToken: 'reconnected',
                refreshToken: 'reconnected-refresh',
            });
        });

        it('a grant the token endpoint refuses expires its connection', async () => {
            if (!admin) return;
            const a = await pod();
            await seed(a, {});
            endpoint.state.refuseAll = true;

            expect(
                await a.mcp.handleRejectedKodusMcpCredential(
                    ORG,
                    INT,
                    bearer('a1'),
                ),
            ).toEqual({ outcome: 'grant_lost' });

            expect(await a.oauth.getOAuthStatus(ORG, INT)).toBe(
                MCPIntegrationOAuthStatus.INACTIVE,
            );
            expect(
                (await a.oauth.getOAuthState(ORG, INT))?.tokens,
            ).toBeUndefined();
            expect(await connectionStatus(a.ds)).toBe(
                MCPConnectionStatus.EXPIRED,
            );
        });

        it('a refused static token expires its connection', async () => {
            if (!admin) return;
            const a = await pod();
            await a.oauth.saveTokenCredential(ORG, INT, {
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.BEARER_TOKEN,
                secret: 'token-refused',
            });
            await activeConnection(a.ds);

            expect(
                await a.mcp.handleRejectedKodusMcpCredential(
                    ORG,
                    INT,
                    bearer('token-refused'),
                ),
            ).toEqual({ outcome: 'token_rejected' });

            expect(await connectionStatus(a.ds)).toBe(
                MCPConnectionStatus.EXPIRED,
            );
        });

        it('a token the user enters while the refused one is handled stays connected', async () => {
            if (!admin) return;
            const a = await pod();
            await a.oauth.saveTokenCredential(ORG, INT, {
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.BEARER_TOKEN,
                secret: 'token-refused',
            });
            await activeConnection(a.ds);
            const handle = a.oauth.handleRejectedCredential.bind(a.oauth);
            jest.spyOn(a.oauth, 'handleRejectedCredential').mockImplementation(
                async (...args) => {
                    const outcome = await handle(...args);
                    // The user reconnects before the connection is expired.
                    await a.oauth.saveTokenCredential(ORG, INT, {
                        authMethodId: 'token',
                        authType: MCPIntegrationAuthType.BEARER_TOKEN,
                        secret: 'token-new',
                    });
                    return outcome;
                },
            );

            expect(
                await a.mcp.handleRejectedKodusMcpCredential(
                    ORG,
                    INT,
                    bearer('token-refused'),
                ),
            ).toEqual({ outcome: 'token_rejected' });

            expect(await connectionStatus(a.ds)).toBe(
                MCPConnectionStatus.ACTIVE,
            );
            expect(await a.oauth.resolveManagedAuthHeaders(ORG, INT)).toEqual({
                Authorization: 'Bearer token-new',
            });
        });
    },
);
