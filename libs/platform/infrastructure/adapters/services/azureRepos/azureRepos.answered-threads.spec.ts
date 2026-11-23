import { AzureReposService } from './azureRepos.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'api' },
    prNumber: 7,
};

const comment = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    content: `comment ${id}`,
    commentType: 'text',
    ...extra,
});
const fileContext = { filePath: '/src/a.ts' };

describe('AzureReposService.getAnsweredReviewThreadRootIds', () => {
    it('keys answered file threads by thread id and skips PR-level, system and deleted', async () => {
        const threads = [
            {
                id: 100,
                threadContext: fileContext,
                comments: [comment(1), comment(2)],
            },
            { id: 101, threadContext: fileContext, comments: [comment(1)] },
            {
                id: 102,
                threadContext: fileContext,
                comments: [comment(1), comment(2, { commentType: 'system' })],
            },
            {
                id: 103,
                threadContext: fileContext,
                comments: [comment(1), comment(2, { isDeleted: true })],
            },
            {
                id: 104,
                threadContext: null,
                comments: [comment(1), comment(2)],
            },
        ];
        const service = Object.create(
            AzureReposService.prototype,
        ) as AzureReposService;
        Object.assign(service, {
            logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
            getAuthDetails: jest
                .fn()
                .mockResolvedValue({ orgName: 'o', token: 't' }),
            getProjectIdFromRepository: jest.fn().mockResolvedValue('p'),
            azureReposRequestHelper: {
                getPullRequestComments: jest.fn().mockResolvedValue(threads),
            },
        });

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['100']));
    });
});
