import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: '42', name: 'api' },
    prNumber: 7,
};

const thread = (fullDatabaseId: string | null, totalCount: number) => ({
    comments: {
        totalCount,
        nodes: fullDatabaseId ? [{ fullDatabaseId }] : [],
    },
});

const page = (nodes: unknown[], endCursor: string | null) => ({
    repository: {
        pullRequest: {
            reviewThreads: {
                nodes,
                pageInfo: { hasNextPage: !!endCursor, endCursor },
            },
        },
    },
});

function build(graphql: jest.Mock) {
    const service = Object.create(GithubService.prototype) as GithubService;
    Object.assign(service, {
        logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        getGithubAuthDetails: jest.fn().mockResolvedValue({
            authMode: AuthMode.OAUTH,
            org: 'acme',
        }),
        instanceGraphQL: jest.fn().mockResolvedValue(graphql),
    });
    return service;
}

describe('GithubService.getAnsweredReviewThreadRootIds', () => {
    it("keys answered threads by the root's REST id, across pages", async () => {
        const graphql = jest
            .fn()
            .mockResolvedValueOnce(
                page([thread('1001', 2), thread('1002', 1)], 'c1'),
            )
            .mockResolvedValueOnce(page([thread('1003', 5)], null));

        await expect(
            build(graphql).getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['1001', '1003']));
        expect(graphql).toHaveBeenCalledTimes(2);
        expect(graphql.mock.calls[1][1]).toMatchObject({
            owner: 'acme',
            name: 'api',
            number: 7,
            cursor: 'c1',
        });
    });

    it('stops when a page reports more without a cursor', async () => {
        const graphql = jest.fn().mockResolvedValue({
            repository: {
                pullRequest: {
                    reviewThreads: {
                        nodes: [thread('1001', 2)],
                        pageInfo: { hasNextPage: true, endCursor: null },
                    },
                },
            },
        });

        await expect(
            build(graphql).getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['1001']));
        expect(graphql).toHaveBeenCalledTimes(1);
    });

    it('matches a numeric suggestion.comment.id once stringified', async () => {
        const graphql = jest
            .fn()
            .mockResolvedValue(page([thread('2147483648123', 2)], null));

        const answered =
            await build(graphql).getAnsweredReviewThreadRootIds(params);

        expect(answered.has(String(2147483648123))).toBe(true);
    });

    it('returns null when GitHub cannot be read', async () => {
        const service = build(jest.fn().mockRejectedValue(new Error('502')));

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toBeNull();
        expect((service as any).logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
    });
});
