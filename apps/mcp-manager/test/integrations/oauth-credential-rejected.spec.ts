import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { IntegrationOAuthService } from '../../src/modules/integrations/integration-oauth.service';
import { MCPIntegrationOAuthEntity } from '../../src/modules/integrations/entities/mcp-integration-oauth.entity';
import {
    MCPIntegrationAuthType,
    MCPIntegrationOAuthStatus,
} from '../../src/modules/integrations/enums/integration.enum';
import { EncryptionUtils } from '../../src/common/utils/encryption';
import { credentialFingerprint } from '@libs/mcp-server/credential-fingerprint';

jest.mock('axios');

// Production 2026-11-20: 352 reviews a day failed to register Linear with
// `invalid_token`. The manager refreshes only by the expiry the provider
// stated, so a token the provider revoked before then — or one that never
// stated an expiry — was handed out again on every review.
class FakeRepo {
    rows: any[] = [];
    private nextId = 1;
    // The refresh lock is a Postgres advisory lock; one process needs none.
    manager = {
        transaction: async (work: (m: any) => Promise<unknown>) =>
            work({ query: async () => [{ locked: true }] }),
    };
    async findOne({ where }: { where: any }) {
        return (
            this.rows.find(
                (r) =>
                    r.integrationId === where.integrationId &&
                    r.organizationId === where.organizationId,
            ) ?? null
        );
    }
    create(obj: any) {
        return { id: `row-${this.nextId++}`, ...obj };
    }
    // Like UPDATE … WHERE: every criterion must still hold.
    async update(criteria: any, partial: any) {
        const row = this.rows.find((r) =>
            Object.entries(criteria).every(([k, v]) => r[k] === v),
        );
        if (!row) return { affected: 0 };
        Object.assign(row, partial);
        return { affected: 1 };
    }
    async save(entity: any) {
        const idx = this.rows.findIndex(
            (r) =>
                r.integrationId === entity.integrationId &&
                r.organizationId === entity.organizationId,
        );
        if (idx >= 0) this.rows[idx] = entity;
        else this.rows.push(entity);
        return entity;
    }
}

const bearer = (token: string) =>
    credentialFingerprint({ Authorization: `Bearer ${token}` })!;

describe('IntegrationOAuthService — the MCP server refused the credential', () => {
    const ORG = 'org-1';
    const INT = 'linear-default';
    let service: IntegrationOAuthService;

    beforeEach(async () => {
        (axios.post as jest.Mock).mockReset();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IntegrationOAuthService,
                EncryptionUtils,
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) =>
                            key === 'encryption.secret'
                                ? 'test-encryption-secret'
                                : undefined,
                    },
                },
                {
                    provide: getRepositoryToken(MCPIntegrationOAuthEntity),
                    useValue: new FakeRepo(),
                },
            ],
        }).compile();
        service = module.get(IntegrationOAuthService);
    });

    // Good for another hour by its stated expiry.
    const storeLive = (tokens: Record<string, unknown> = {}) =>
        service.saveOAuthState(ORG, INT, MCPIntegrationOAuthStatus.ACTIVE, {
            clientId: 'client-1',
            redirectUri: 'https://app.kodus.io/callback',
            asMetadata: { token_endpoint: 'https://idp/token' },
            tokens: {
                accessToken: 'revoked-access',
                refreshToken: 'r1',
                expiresIn: 3600,
                expiresAt: Date.now() + 3_600_000,
                ...tokens,
            },
        } as any);

    it('refreshes a token the server refused before its stated expiry', async () => {
        await storeLive();
        (axios.post as jest.Mock).mockResolvedValue({
            status: 200,
            data: {
                access_token: 'fresh-access',
                refresh_token: 'r2',
                expires_in: 3600,
            },
        });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('revoked-access'),
            ),
        ).toBe('refreshed');

        const [url, body] = (axios.post as jest.Mock).mock.calls[0];
        expect(url).toBe('https://idp/token');
        expect(new URLSearchParams(body).get('refresh_token')).toBe('r1');
        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer fresh-access',
        });
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.ACTIVE,
        );
    });

    it('loses the grant when the refresh is refused too', async () => {
        await storeLive();
        (axios.post as jest.Mock).mockResolvedValue({
            status: 400,
            data: { error: 'invalid_grant' },
        });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('revoked-access'),
            ),
        ).toBe('grant_lost');
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.INACTIVE,
        );
        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({});
    });

    it('loses the grant of a token with nothing to refresh it, even one that never stated an expiry', async () => {
        await storeLive({
            refreshToken: undefined,
            expiresIn: undefined,
            expiresAt: undefined,
        });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('revoked-access'),
            ),
        ).toBe('grant_lost');
        expect(axios.post).not.toHaveBeenCalled();
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.INACTIVE,
        );
    });

    it('keeps the grant when the refresh fails for a reason that can pass', async () => {
        await storeLive();
        (axios.post as jest.Mock).mockResolvedValue({
            status: 503,
            data: 'Service Unavailable',
        });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('revoked-access'),
            ),
        ).toBe('kept');
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.ACTIVE,
        );
    });

    it('does nothing when the refused token is no longer the stored one', async () => {
        // Refreshed or reconnected after the worker read it.
        await storeLive({ accessToken: 'newer-access' });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('revoked-access'),
            ),
        ).toBe('stale');
        expect(axios.post).not.toHaveBeenCalled();
        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer newer-access',
        });
    });

    it('reports a refused static token, and only the one stored now', async () => {
        await service.saveTokenCredential(ORG, INT, {
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BEARER_TOKEN,
            secret: 'lin_api_revoked',
        });

        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('lin_api_revoked'),
            ),
        ).toBe('token_rejected');
        expect(
            await service.handleRejectedCredential(
                ORG,
                INT,
                bearer('lin_api_older'),
            ),
        ).toBe('stale');
        expect(axios.post).not.toHaveBeenCalled();
    });
});
