import axios from 'axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { IntegrationOAuthService } from '../../src/modules/integrations/integration-oauth.service';
import { MCPIntegrationOAuthEntity } from '../../src/modules/integrations/entities/mcp-integration-oauth.entity';
import { MCPIntegrationOAuthStatus } from '../../src/modules/integrations/enums/integration.enum';
import { EncryptionUtils } from '../../src/common/utils/encryption';

jest.mock('axios');

// Production 2026-10-29: ~1.4k reviews a day failed to register Linear (and
// Sentry, Notion, ClickUp) with `invalid_token`. When a token can no longer be
// refreshed, the manager kept handing out the expired one with the grant still
// ACTIVE, so every review retried it and the UI never asked to reconnect.
class FakeRepo {
    rows: any[] = [];
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
        return { ...obj };
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

describe('IntegrationOAuthService — a grant that can no longer be refreshed', () => {
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

    const storeExpired = (tokens: Record<string, unknown>) =>
        service.saveOAuthState(ORG, INT, MCPIntegrationOAuthStatus.ACTIVE, {
            clientId: 'client-1',
            redirectUri: 'https://app.kodus.io/callback',
            asMetadata: { token_endpoint: 'https://idp/token' },
            tokens: {
                accessToken: 'expired-access',
                expiresIn: 3600,
                expiresAt: Date.now() - 60_000,
                ...tokens,
            },
        } as any);

    it('stops sending the token and marks the grant inactive when the provider rejects the refresh', async () => {
        await storeExpired({ refreshToken: 'revoked-refresh' });
        (axios.post as jest.Mock).mockResolvedValue({
            status: 400,
            data: { error: 'invalid_grant' },
        });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({});
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.INACTIVE,
        );

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({});
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('drops the stored tokens, so no other read path hands them out', async () => {
        await storeExpired({ refreshToken: 'revoked-refresh' });
        (axios.post as jest.Mock).mockResolvedValue({
            status: 400,
            data: { error: 'invalid_grant' },
        });

        await service.resolveManagedAuthHeaders(ORG, INT);

        expect((await service.getOAuthState(ORG, INT))?.tokens).toBeUndefined();
    });

    it.each([
        ['400 invalid_request', 400, 'invalid_request'],
        ['401 invalid_client', 401, 'invalid_client'],
    ])(
        'keeps the grant on a %s, which does not say the grant is gone',
        async (_label, status, error) => {
            await storeExpired({ refreshToken: 'good-refresh' });
            (axios.post as jest.Mock).mockResolvedValue({
                status,
                data: { error },
            });

            await service.resolveManagedAuthHeaders(ORG, INT);

            expect(await service.getOAuthStatus(ORG, INT)).toBe(
                MCPIntegrationOAuthStatus.ACTIVE,
            );
        },
    );

    it('keeps the grant another request rotated while this one was refused', async () => {
        await storeExpired({ refreshToken: 'r1' });
        (axios.post as jest.Mock).mockImplementation(async () => {
            // A concurrent request spent r1 first and saved the rotated grant.
            await service.saveOAuthState(
                ORG,
                INT,
                MCPIntegrationOAuthStatus.ACTIVE,
                {
                    clientId: 'client-1',
                    redirectUri: 'https://app.kodus.io/callback',
                    asMetadata: { token_endpoint: 'https://idp/token' },
                    tokens: {
                        accessToken: 'fresh-access',
                        refreshToken: 'r2',
                        expiresIn: 3600,
                        expiresAt: Date.now() + 3_600_000,
                    },
                } as any,
            );
            return { status: 400, data: { error: 'invalid_grant' } };
        });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer fresh-access',
        });
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.ACTIVE,
        );
    });

    it('marks the grant inactive when an expiring token has no refresh token', async () => {
        await storeExpired({ refreshToken: undefined });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({});
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.INACTIVE,
        );
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('keeps the grant when the token endpoint fails for a reason that can pass', async () => {
        await storeExpired({ refreshToken: 'good-refresh' });
        (axios.post as jest.Mock).mockResolvedValue({
            status: 503,
            data: 'Service Unavailable',
        });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer expired-access',
        });
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.ACTIVE,
        );
    });

    it('keeps a token whose provider never said when it expires', async () => {
        await storeExpired({ expiresIn: undefined, refreshToken: undefined });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer expired-access',
        });
        expect(await service.getOAuthStatus(ORG, INT)).toBe(
            MCPIntegrationOAuthStatus.ACTIVE,
        );
    });
});
