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
import { ManagedTokenCredential } from '../../src/modules/integrations/managed-credential.types';

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
        if (idx >= 0) {
            this.rows[idx] = entity;
        } else {
            this.rows.push(entity);
        }
        return entity;
    }

    async delete() {
        /* unused here */
    }
}

describe('IntegrationOAuthService — managed token credentials', () => {
    let service: IntegrationOAuthService;
    let repo: FakeRepo;

    const ORG = 'org-1';
    const INT = 'atlassian-rovo-default';

    const jiraCredential: ManagedTokenCredential = {
        authMethodId: 'token',
        authType: MCPIntegrationAuthType.BASIC,
        secret: 'super-secret-api-token',
        fields: { email: 'dev@kodus.io', cloudId: 'cid-123' },
    };

    beforeEach(async () => {
        repo = new FakeRepo();

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
                    useValue: repo,
                },
            ],
        }).compile();

        service = module.get(IntegrationOAuthService);
    });

    it('round-trips a saved token credential', async () => {
        await service.saveTokenCredential(ORG, INT, jiraCredential);

        const loaded = await service.getManagedCredential(ORG, INT);
        expect(loaded).toEqual(jiraCredential);
    });

    it('stores the secret encrypted at rest, not in plaintext', async () => {
        await service.saveTokenCredential(ORG, INT, jiraCredential);

        const stored = repo.rows[0];
        expect(stored.auth).toBeDefined();
        expect(stored.auth).not.toContain('super-secret-api-token');
        expect(stored.status).toBe(MCPIntegrationOAuthStatus.ACTIVE);
    });

    it('returns null when no credential is stored', async () => {
        expect(await service.getManagedCredential(ORG, 'nope')).toBeNull();
    });

    it('does not mistake stored OAuth state for a token credential', async () => {
        await service.saveOAuthState(
            ORG,
            INT,
            MCPIntegrationOAuthStatus.ACTIVE,
            { clientId: 'abc', tokens: { accessToken: 'tok' } as any },
        );

        expect(await service.getManagedCredential(ORG, INT)).toBeNull();
    });

    it('overwrites a prior credential for the same org+integration', async () => {
        await service.saveTokenCredential(ORG, INT, jiraCredential);
        const updated: ManagedTokenCredential = {
            ...jiraCredential,
            secret: 'rotated-token',
        };
        await service.saveTokenCredential(ORG, INT, updated);

        expect(repo.rows).toHaveLength(1);
        expect((await service.getManagedCredential(ORG, INT))?.secret).toBe(
            'rotated-token',
        );
    });
});
