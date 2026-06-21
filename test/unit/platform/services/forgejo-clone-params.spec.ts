import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { decrypt } from '@libs/common/utils/crypto';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { PlatformType } from '@libs/core/domain/enums';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;

describe('ForgejoService.getCloneParams', () => {
    let service: any;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                ForgejoService,
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn() },
                },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationService>,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationConfigService>,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IAuthIntegrationService>,
                },
            ],
        }).compile();

        service = moduleRef.get(ForgejoService);

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.example.com',
            accessToken: 'encrypted-token',
            authMode: 'oauth',
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('prefers repository.fullName when building the clone URL', async () => {
        const params = await service.getCloneParams({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: {
                id: 'repo-789',
                name: 'kodus-ai',
                fullName: 'kodustech/kodus-ai',
                defaultBranch: 'main',
            },
        });

        expect(params).toEqual({
            url: 'https://git.example.com/kodustech/kodus-ai.git',
            provider: PlatformType.FORGEJO,
            organizationId: 'org-123',
            repositoryId: 'repo-789',
            repositoryName: 'kodus-ai',
            branch: 'main',
            auth: {
                type: 'oauth',
                username: 'oauth2',
                token: 'encrypted-token',
            },
        });
        expect(decrypt).toHaveBeenCalledWith('encrypted-token');
    });

    it('falls back to repository.name when fullName is missing', async () => {
        const params = await service.getCloneParams({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: {
                id: 'repo-789',
                name: 'kodustech/kodus-ai',
                defaultBranch: 'main',
            },
        });

        expect(params.url).toBe('https://git.example.com/kodustech/kodus-ai.git');
        expect(params.repositoryName).toBe('kodus-ai');
    });
});
