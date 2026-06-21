import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

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

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const repoListHooksMock = jest.fn();
const repoCreateHookMock = jest.fn();
const repoEditHookMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoListHooks: (...args: unknown[]) => repoListHooksMock(...args),
    repoCreateHook: (...args: unknown[]) => repoCreateHookMock(...args),
    repoEditHook: (...args: unknown[]) => repoEditHookMock(...args),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;

describe('ForgejoService.createPullRequestWebhook', () => {
    let service: any;
    let configService: { get: jest.Mock };

    beforeAll(async () => {
        const module =
            await import('@libs/platform/infrastructure/adapters/services/forgejo.service');
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        repoListHooksMock.mockReset();
        repoCreateHookMock.mockReset();
        repoEditHookMock.mockReset();

        configService = {
            get: jest
                .fn()
                .mockReturnValue('https://api.example.com/forgejo/webhook'),
        };

        const moduleRef = await Test.createTestingModule({
            providers: [
                ForgejoService,
                {
                    provide: ConfigService,
                    useValue: configService,
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
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([
            {
                id: '22',
                name: 'kodustech/kodus-ai',
            },
        ]);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('creates Forgejo webhooks with push events enabled', async () => {
        repoListHooksMock.mockResolvedValue({ data: [] });
        repoCreateHookMock.mockResolvedValue({ data: { id: 99 } });

        await service.createPullRequestWebhook({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
        });

        expect(repoCreateHookMock).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    events: [
                        'push',
                        'pull_request',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ],
                }),
            }),
        );
        expect(repoEditHookMock).not.toHaveBeenCalled();
    });

    it('updates existing Forgejo webhooks when push is missing', async () => {
        repoListHooksMock.mockResolvedValue({
            data: [
                {
                    id: 99,
                    active: true,
                    events: [
                        'pull_request',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ],
                    config: {
                        url: 'https://api.example.com/forgejo/webhook',
                    },
                },
            ],
        });
        repoEditHookMock.mockResolvedValue({ data: { id: 99 } });

        await service.createPullRequestWebhook({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
        });

        expect(repoEditHookMock).toHaveBeenCalledWith(
            expect.objectContaining({
                path: expect.objectContaining({ id: 99 }),
                body: expect.objectContaining({
                    events: [
                        'push',
                        'pull_request',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ],
                    active: true,
                }),
            }),
        );
        expect(repoCreateHookMock).not.toHaveBeenCalled();
    });

    it('does not update existing Forgejo webhooks when push is already enabled', async () => {
        repoListHooksMock.mockResolvedValue({
            data: [
                {
                    id: 99,
                    active: true,
                    events: [
                        'push',
                        'pull_request',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ],
                    config: {
                        url: 'https://api.example.com/forgejo/webhook',
                    },
                },
            ],
        });

        await service.createPullRequestWebhook({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
        });

        expect(repoCreateHookMock).not.toHaveBeenCalled();
        expect(repoEditHookMock).not.toHaveBeenCalled();
    });
});
