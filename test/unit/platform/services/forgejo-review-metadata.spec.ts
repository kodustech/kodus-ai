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

const repoListPullReviewsMock = jest.fn();
const repoGetPullReviewCommentsMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoListPullReviews: (...args: unknown[]) => repoListPullReviewsMock(...args),
    repoGetPullReviewComments: (...args: unknown[]) =>
        repoGetPullReviewCommentsMock(...args),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;

describe('ForgejoService review metadata mapping', () => {
    let service: any;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        repoListPullReviewsMock.mockReset();
        repoGetPullReviewCommentsMock.mockReset();

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

    it('adds thread, resolved, and outdated metadata to review threads', async () => {
        repoListPullReviewsMock
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 11,
                        stale: true,
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] });

        repoGetPullReviewCommentsMock.mockResolvedValue({
            data: [
                {
                    id: 101,
                    body: 'Needs work',
                    created_at: '2024-01-16T10:00:00Z',
                    updated_at: '2024-01-16T10:00:00Z',
                    resolver: { id: 9 },
                    user: {
                        id: 7,
                        login: 'reviewer',
                        full_name: 'Reviewer Name',
                    },
                },
            ],
        });

        const result = await service.getPullRequestReviewThreads({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: { name: 'kodustech/kodus-ai' },
            prNumber: 42,
        });

        expect(result).toEqual([
            {
                id: 101,
                threadId: '11',
                isResolved: true,
                isOutdated: true,
                body: 'Needs work',
                createdAt: '2024-01-16T10:00:00Z',
                updatedAt: '2024-01-16T10:00:00Z',
                author: {
                    id: '7',
                    username: 'reviewer',
                    name: 'Reviewer Name',
                },
            },
        ]);
    });

    it('adds thread, resolved, and outdated metadata to review comments', async () => {
        repoListPullReviewsMock
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 21,
                        stale: false,
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] });

        repoGetPullReviewCommentsMock.mockResolvedValue({
            data: [
                {
                    id: 202,
                    body: 'Nit',
                    created_at: '2024-01-16T10:00:00Z',
                    updated_at: '2024-01-16T10:00:00Z',
                    resolver: null,
                    user: {
                        id: 8,
                        login: 'reviewer2',
                        full_name: 'Reviewer Two',
                    },
                },
            ],
        });

        const result = await service.getPullRequestReviewComments({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: { name: 'kodustech/kodus-ai' },
            prNumber: 42,
        });

        expect(result).toEqual([
            {
                id: 202,
                threadId: '21',
                isResolved: false,
                isOutdated: false,
                body: 'Nit',
                createdAt: '2024-01-16T10:00:00Z',
                updatedAt: '2024-01-16T10:00:00Z',
                author: {
                    id: '8',
                    username: 'reviewer2',
                    name: 'Reviewer Two',
                },
            },
        ]);
    });
});
