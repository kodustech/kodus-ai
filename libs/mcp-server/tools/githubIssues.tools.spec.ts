import { Test, TestingModule } from '@nestjs/testing';

import { GithubIssuesService } from '@libs/platform/infrastructure/adapters/services/github/github-issues.service';

import { GithubIssuesTools } from './githubIssues.tools';

describe('GithubIssuesTools', () => {
    let tools: GithubIssuesTools;
    let mockGithubIssuesService: jest.Mocked<GithubIssuesService>;

    beforeEach(async () => {
        mockGithubIssuesService = {
            listIssues: jest.fn(),
            getIssue: jest.fn(),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GithubIssuesTools,
                {
                    provide: GithubIssuesService,
                    useValue: mockGithubIssuesService,
                },
            ],
        }).compile();

        tools = module.get<GithubIssuesTools>(GithubIssuesTools);
    });

    it('should expose both GitHub issues MCP tools', () => {
        const toolNames = tools.getAllTools().map((tool) => tool.name);

        expect(toolNames).toEqual([
            'KODUS_LIST_GITHUB_ISSUES',
            'KODUS_GET_GITHUB_ISSUE',
        ]);
    });

    it('should execute list tool and return wrapped structured content', async () => {
        const issue = {
            id: 1,
            nodeId: 'I_1',
            number: 42,
            title: 'Issue title',
            body: null,
            state: 'open' as const,
            locked: false,
            htmlUrl: 'https://github.com/kodustech/kodus-ai/issues/42',
            comments: 1,
            labels: ['bug'],
            assignees: ['jairo'],
            user: null,
            createdAt: '2026-03-01T00:00:00Z',
            updatedAt: '2026-03-01T00:00:00Z',
            closedAt: null,
        };
        mockGithubIssuesService.listIssues.mockResolvedValue([issue]);

        const result = await tools.listGithubIssues().execute({
            organizationId: 'org',
            teamId: 'team',
            repository: {
                owner: 'kodustech',
                name: 'kodus-ai',
            },
        } as any);

        expect(mockGithubIssuesService.listIssues).toHaveBeenCalled();
        expect((result as any).structuredContent).toEqual({
            success: true,
            count: 1,
            data: [issue],
        });
    });

    it('should execute get tool and return null data when service does not find issue', async () => {
        mockGithubIssuesService.getIssue.mockResolvedValue(null);

        const result = await tools.getGithubIssue().execute({
            organizationId: 'org',
            teamId: 'team',
            repository: {
                owner: 'kodustech',
                name: 'kodus-ai',
            },
            issueNumber: 999,
        } as any);

        expect(mockGithubIssuesService.getIssue).toHaveBeenCalledWith(
            expect.objectContaining({
                issueNumber: 999,
            }),
        );
        expect((result as any).structuredContent).toEqual({
            success: true,
            data: null,
        });
    });
});
