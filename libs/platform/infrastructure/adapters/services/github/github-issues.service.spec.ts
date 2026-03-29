import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { Test, TestingModule } from '@nestjs/testing';

import { GithubIssuesService } from './github-issues.service';
import { GithubService } from './github.service';

describe('GithubIssuesService', () => {
    let service: GithubIssuesService;
    let mockGithubService: jest.Mocked<GithubService>;
    let mockIntegrationService: { findOne: jest.Mock };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;

    const repository = {
        owner: 'kodustech',
        name: 'kodus-ai',
    };

    beforeEach(async () => {
        mockGithubService = {
            getAuthenticatedOctokit: jest.fn(),
        } as any;

        mockIntegrationService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GithubIssuesService,
                {
                    provide: GithubService,
                    useValue: mockGithubService,
                },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: mockIntegrationService,
                },
            ],
        }).compile();

        service = module.get<GithubIssuesService>(GithubIssuesService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should list mapped issues and filter pull requests', async () => {
        const mockOctokit = {
            rest: {
                issues: {
                    listForRepo: jest.fn().mockResolvedValue({
                        data: [
                            {
                                id: 10,
                                node_id: 'I_10',
                                number: 33,
                                title: 'Bug report',
                                body: 'Details',
                                state: 'open',
                                locked: false,
                                html_url:
                                    'https://github.com/kodustech/kodus-ai/issues/33',
                                comments: 2,
                                labels: [{ name: 'bug' }],
                                assignees: [{ login: 'jairo' }],
                                user: {
                                    login: 'reporter',
                                    id: 90,
                                    avatar_url: 'https://avatar',
                                    html_url: 'https://github.com/reporter',
                                },
                                created_at: '2026-01-01T00:00:00Z',
                                updated_at: '2026-01-02T00:00:00Z',
                                closed_at: null,
                            },
                            {
                                id: 11,
                                node_id: 'I_11',
                                number: 34,
                                title: 'PR in issues API',
                                body: null,
                                state: 'open',
                                locked: false,
                                html_url:
                                    'https://github.com/kodustech/kodus-ai/pull/34',
                                comments: 0,
                                labels: [],
                                assignees: [],
                                user: null,
                                created_at: '2026-01-01T00:00:00Z',
                                updated_at: '2026-01-02T00:00:00Z',
                                closed_at: null,
                                pull_request: {},
                            },
                        ],
                    }),
                },
            },
        } as any;

        mockGithubService.getAuthenticatedOctokit.mockResolvedValue(
            mockOctokit,
        );

        const result = await service.listIssues({
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository,
            filters: {
                state: 'open',
                labels: ['bug', 'backend'],
                page: 1,
                perPage: 20,
            },
        });

        expect(mockOctokit.rest.issues.listForRepo).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'kodustech',
                repo: 'kodus-ai',
                state: 'open',
                labels: 'bug,backend',
                page: 1,
                per_page: 20,
            }),
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: 10,
            number: 33,
            title: 'Bug report',
            labels: ['bug'],
            assignees: ['jairo'],
        });
    });

    it('should return null when issue is not found', async () => {
        const mockOctokit = {
            rest: {
                issues: {
                    get: jest.fn().mockRejectedValue({ status: 404 }),
                },
            },
        } as any;

        mockGithubService.getAuthenticatedOctokit.mockResolvedValue(
            mockOctokit,
        );

        const result = await service.getIssue({
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository,
            issueNumber: 999,
        });

        expect(result).toBeNull();
    });

    it('should return null for pull request numbers in get issue', async () => {
        const mockOctokit = {
            rest: {
                issues: {
                    get: jest.fn().mockResolvedValue({
                        data: {
                            id: 12,
                            number: 35,
                            pull_request: {},
                        },
                    }),
                },
            },
        } as any;

        mockGithubService.getAuthenticatedOctokit.mockResolvedValue(
            mockOctokit,
        );

        const result = await service.getIssue({
            organizationAndTeamData: mockOrganizationAndTeamData,
            repository,
            issueNumber: 35,
        });

        expect(result).toBeNull();
    });

    it('should throw when no valid GitHub integration exists', async () => {
        mockIntegrationService.findOne.mockResolvedValue(null);

        await expect(
            service.listIssues({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository,
            }),
        ).rejects.toThrow(
            'A valid GitHub integration is required for this organization/team',
        );
        expect(
            mockGithubService.getAuthenticatedOctokit,
        ).not.toHaveBeenCalled();
    });
});
