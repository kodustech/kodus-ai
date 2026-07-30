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

describe('IntegrationOAuthService.resolveManagedAuthHeaders', () => {
    let service: IntegrationOAuthService;
    const ORG = 'org-1';
    const INT = 'linear-default';

    beforeEach(async () => {
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

    it('returns token headers when a static-token credential is stored', async () => {
        await service.saveTokenCredential(ORG, INT, {
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BEARER_TOKEN,
            secret: 'lin_api_xyz',
        });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer lin_api_xyz',
        });
    });

    it('returns a Bearer header from a stored OAuth access token', async () => {
        await service.saveOAuthState(
            ORG,
            INT,
            MCPIntegrationOAuthStatus.ACTIVE,
            {
                clientId: 'client-1',
                tokens: {
                    accessToken: 'oauth-access-token',
                    // far-future expiry → no refresh network call
                    expiresAt: Date.now() + 3_600_000,
                } as any,
            },
        );

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer oauth-access-token',
        });
    });

    it('prefers the static-token credential over OAuth when both exist', async () => {
        await service.saveTokenCredential(ORG, INT, {
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BEARER_TOKEN,
            secret: 'token-wins',
        });

        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({
            Authorization: 'Bearer token-wins',
        });
    });

    it('returns no headers when nothing is stored (none-auth server)', async () => {
        expect(await service.resolveManagedAuthHeaders(ORG, INT)).toEqual({});
    });
});

describe('IntegrationOAuthService.hasManagedCredential', () => {
    let service: IntegrationOAuthService;
    const ORG = 'org-1';
    const INT = 'linear-default';

    beforeEach(async () => {
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

    it('is true when a static token credential exists', async () => {
        await service.saveTokenCredential(ORG, INT, {
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BEARER_TOKEN,
            secret: 'tok',
        });
        expect(await service.hasManagedCredential(ORG, INT)).toBe(true);
    });

    it('is true when an ACTIVE OAuth grant exists', async () => {
        await service.saveOAuthState(
            ORG,
            INT,
            MCPIntegrationOAuthStatus.ACTIVE,
            { clientId: 'c', tokens: { accessToken: 'a' } as any },
        );
        expect(await service.hasManagedCredential(ORG, INT)).toBe(true);
    });

    it('is false when nothing is stored', async () => {
        expect(await service.hasManagedCredential(ORG, INT)).toBe(false);
    });

    it('is false when an OAuth grant exists but is not ACTIVE', async () => {
        await service.saveOAuthState(
            ORG,
            INT,
            MCPIntegrationOAuthStatus.PENDING,
            { clientId: 'c' },
        );
        expect(await service.hasManagedCredential(ORG, INT)).toBe(false);
    });
});
