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

const repoListPullRequestsMock = jest.fn();
const repoGetPullRequestFilesMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoListPullRequests: (...args: unknown[]) =>
        repoListPullRequestsMock(...args),
    repoGetPullRequestFiles: (...args: unknown[]) =>
        repoGetPullRequestFilesMock(...args),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;

describe('ForgejoService fullName pull request mapping', () => {
    let service: any;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        repoListPullRequestsMock.mockReset();
        repoGetPullRequestFilesMock.mockReset();

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

    it('uses repository full names when mapping a pull request', () => {
        const transformed = (service as any).transformPullRequest(
            {
                id: 42,
                number: 7,
                title: 'Fix login flow',
                body: 'Details',
                state: 'open',
                html_url: 'https://git.example.com/kodustech/kodus-ai/pulls/7',
                created_at: '2024-01-16T10:00:00Z',
                updated_at: '2024-01-16T10:00:00Z',
                closed_at: null,
                merged_at: null,
                draft: false,
                merged: false,
                user: {
                    id: 5,
                    login: 'author',
                    full_name: 'Author Name',
                },
                head: {
                    ref: 'feature/auth',
                    sha: 'head-sha',
                    repo: {
                        id: 22,
                        name: 'kodus-ai',
                        full_name: 'kodustech/kodus-ai',
                        default_branch: 'main',
                    },
                },
                base: {
                    ref: 'main',
                    sha: 'base-sha',
                    repo: {
                        id: 22,
                        name: 'kodus-ai',
                        full_name: 'kodustech/kodus-ai',
                    },
                },
            },
            {
                id: '22',
                name: 'kodustech/kodus-ai',
                default_branch: 'main',
            },
        );

        expect(transformed.repository).toBe('kodustech/kodus-ai');
        expect(transformed.repositoryData).toEqual({
            id: '22',
            name: 'kodustech/kodus-ai',
        });
        expect(transformed.base.repo).toEqual({
            id: '22',
            name: 'kodus-ai',
            defaultBranch: 'main',
            fullName: 'kodustech/kodus-ai',
        });
    });

    it('keeps full repository names in getPullRequestsWithFiles results', async () => {
        repoListPullRequestsMock
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 42,
                        number: 7,
                        title: 'Fix login flow',
                        state: 'open',
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] });
        repoGetPullRequestFilesMock
            .mockResolvedValueOnce({
                data: [
                    {
                        additions: 3,
                        deletions: 1,
                        changes: 4,
                        status: 'modified',
                    },
                ],
            })
            .mockResolvedValueOnce({ data: [] });

        const result = await service.getPullRequestsWithFiles({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: {
                id: '22',
                name: 'kodustech/kodus-ai',
            },
        });

        expect(result).toEqual([
            {
                id: 42,
                pull_number: 7,
                state: 'open',
                title: 'Fix login flow',
                repository: 'kodustech/kodus-ai',
                repositoryData: {
                    platform: 'forgejo',
                    id: '22',
                    name: 'kodustech/kodus-ai',
                    fullName: 'kodustech/kodus-ai',
                    language: '',
                    defaultBranch: 'main',
                },
                pullRequestFiles: [
                    {
                        additions: 3,
                        deletions: 1,
                        changes: 4,
                        status: 'modified',
                    },
                ],
            },
        ]);
    });
});
