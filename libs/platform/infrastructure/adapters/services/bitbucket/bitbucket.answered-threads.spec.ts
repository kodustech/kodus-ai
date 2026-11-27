import { formatBitbucketPromptReply } from '@libs/common/utils/codeManagement/bitbucket-suggestion-comment';

import { BitbucketCloudService } from './bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket-data-center.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'api' },
    prNumber: 7,
};
const PROMPT = formatBitbucketPromptReply('fix it');

const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    Object.assign(service, {
        logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        ...overrides,
    });
    return service;
};

describe('BitbucketCloudService.getAnsweredReviewThreadRootIds', () => {
    const comment = (id: number, raw: string, parent?: number, extra = {}) => ({
        id,
        content: { raw },
        parent: parent ? { id: parent } : undefined,
        created_on: `2026-10-01T00:00:${String(id).padStart(2, '0')}Z`,
        ...extra,
    });

    const build = (comments: unknown[]) =>
        make(BitbucketCloudService, {
            getAuthDetails: jest.fn().mockResolvedValue({}),
            getWorkspaceFromRepository: jest.fn().mockResolvedValue('ws'),
            instanceBitbucketApi: () => ({
                pullrequests: {
                    listComments: jest.fn().mockResolvedValue({}),
                },
            }),
            getPaginatedResults: jest.fn().mockResolvedValue(comments),
        });

    it("counts a real reply, not Kody's prompt reply, and reaches replies under the prompt", async () => {
        const service = build([
            comment(1, 'finding answered'),
            comment(2, PROMPT, 1),
            comment(3, 'why?', 1),
            comment(4, 'finding with only the prompt'),
            comment(5, PROMPT, 4),
            comment(6, 'finding answered under the prompt'),
            comment(7, PROMPT, 6),
            comment(8, 'done', 7),
            comment(9, 'deleted reply only'),
            comment(10, '', 9, { deleted: true }),
        ]);

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['1', '6']));
    });
});

describe('BitbucketDataCenterService.getAnsweredReviewThreadRootIds', () => {
    const build = (values: unknown[]) =>
        make(BitbucketDataCenterService, {
            getAuthDetails: jest.fn().mockResolvedValue({}),
            getRepoConfig: jest
                .fn()
                .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' }),
            getAxiosInstance: () => ({
                get: jest.fn().mockResolvedValue({ data: { values } }),
            }),
        });

    it('reads the replies nested under each added root comment', async () => {
        const service = build([
            {
                action: 'COMMENTED',
                commentAction: 'ADDED',
                comment: { id: 11, comments: [{ id: 12, text: PROMPT }] },
            },
            {
                action: 'COMMENTED',
                commentAction: 'ADDED',
                comment: {
                    id: 21,
                    comments: [
                        {
                            id: 22,
                            text: PROMPT,
                            comments: [{ id: 23, text: 'done' }],
                        },
                    ],
                },
            },
            {
                action: 'COMMENTED',
                commentAction: 'REPLIED',
                comment: { id: 23, comments: [] },
            },
            { action: 'APPROVED' },
        ]);

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['21']));
    });

    it('reads every page of activities', async () => {
        const get = jest
            .fn()
            .mockResolvedValueOnce({
                data: {
                    values: [
                        {
                            action: 'COMMENTED',
                            commentAction: 'ADDED',
                            comment: { id: 61 },
                        },
                    ],
                    isLastPage: false,
                    nextPageStart: 1000,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    values: [
                        {
                            action: 'COMMENTED',
                            commentAction: 'ADDED',
                            comment: { id: 62, text: 'ok', parent: { id: 61 } },
                        },
                    ],
                    isLastPage: true,
                },
            });
        const service = make(BitbucketDataCenterService, {
            getAuthDetails: jest.fn().mockResolvedValue({}),
            getRepoConfig: jest
                .fn()
                .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' }),
            getAxiosInstance: () => ({ get }),
        });

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['61']));
        expect(get.mock.calls[1][1].params.start).toBe(1000);
    });

    it('reads replies added as their own activities, by parent', async () => {
        const added = (comment: object) => ({
            action: 'COMMENTED',
            commentAction: 'ADDED',
            comment,
        });
        const service = build([
            added({ id: 31 }),
            added({ id: 32, text: 'why?', parent: { id: 31 } }),
            added({ id: 41 }),
            added({ id: 42, text: PROMPT, parent: { id: 41 } }),
            added({ id: 51 }),
            added({ id: 52, text: PROMPT, parent: { id: 51 } }),
            added({ id: 53, text: 'done', parent: { id: 52 } }),
        ]);

        await expect(
            service.getAnsweredReviewThreadRootIds(params),
        ).resolves.toEqual(new Set(['31', '51']));
    });
});
