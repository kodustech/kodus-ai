jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({ id: 'TR-test', metadata: {} })),
}));

jest.mock('./implicit-reply', () => ({
    ...jest.requireActual('./implicit-reply'),
    classifyReplyAddressedToKody: jest.fn().mockResolvedValue(true),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';

/**
 * With several webhooks pointing at Kodus, the platform delivers the same
 * comment once per hook, each as its own job.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const MARKER = '<!-- kody-codereview -->';

/**
 * Same contract as MessageClaimService: the first caller for a key gets true,
 * later callers get false while it is held or done.
 */
function fakeInbox() {
    const rows = new Map<string, string>();
    return {
        rows,
        claim: jest.fn(async (consumerId: string, key: string) => {
            const row = `${consumerId}|${key}`;
            if (rows.has(row)) return false;
            rows.set(row, 'PROCESSING');
            return true;
        }),
        release: jest.fn(async (consumerId: string, key: string) => {
            rows.delete(`${consumerId}|${key}`);
        }),
        complete: jest.fn(async (consumerId: string, key: string) => {
            rows.set(`${consumerId}|${key}`, 'PROCESSED');
        }),
    };
}

function setup(inbox: any = fakeInbox()) {
    const originalCommit = { id: 20, body: `Missing null check. ${MARKER}` };
    const comments = [
        {
            id: 20,
            body: originalCommit.body,
            createdAt: '2026-09-28T19:00:00Z',
            discussionId: 'd1',
            originalCommit,
            author: { id: 1, username: 'group_1_bot_abc', name: 'Kody' },
        },
        {
            id: 21,
            body: 'fixed, retry is bounded now',
            createdAt: '2026-09-28T19:01:00Z',
            discussionId: 'd1',
            originalCommit,
            author: { id: 7, username: 'alice', name: 'Alice' },
        },
    ];

    const codeManagementService = {
        findTeamAndOrganizationIdByConfigKey: jest.fn().mockResolvedValue({
            integration: { organization: { uuid: ORG } },
            team: { uuid: TEAM },
        }),
        getPullRequestReviewComment: jest.fn().mockResolvedValue(comments),
        addReactionToComment: jest.fn().mockResolvedValue(undefined),
        removeReactionsFromComment: jest.fn().mockResolvedValue(undefined),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 999 }),
        updateResponseToComment: jest.fn().mockResolvedValue({}),
        getCloneParams: jest.fn().mockResolvedValue(undefined),
    };
    const conversationAgentUseCase = {
        execute: jest.fn().mockResolvedValue('an answer'),
    };
    const useCase = new ChatWithKodyFromGitUseCase(
        codeManagementService as any,
        conversationAgentUseCase as any,
        { execute: jest.fn() } as any,
        {
            validateExecutionPermissions: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            resolveTaskSlot: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
            acquire: jest.fn().mockResolvedValue({
                sandbox: { type: 'null' },
                leaseId: 'lease',
            }),
            release: jest.fn().mockResolvedValue(undefined),
        } as any,
        { findByNumberAndRepositoryId: jest.fn().mockResolvedValue(null) } as any,
        inbox,
    );

    return { useCase, codeManagementService, conversationAgentUseCase, inbox };
}

// The same Note Hook body, as each of the project's hooks delivers it.
const delivery = (
    body = 'fixed, retry is bounded now',
    updatedAt = '2026-09-28 19:01:00 UTC',
) =>
    ({
        event: 'note',
        platformType: PlatformType.GITLAB,
        payload: {
            event_type: 'note',
            object_attributes: {
                id: 21,
                note: body,
                discussion_id: 'd1',
                type: 'DiffNote',
                action: 'create',
                updated_at: updatedAt,
            },
            project: {
                id: 'repo-1',
                name: 'api',
                path_with_namespace: 'acme/api',
            },
            merge_request: { iid: 346 },
            user: { id: 7, name: 'Alice' },
        },
    }) as any;

describe('ChatWithKodyFromGitUseCase — one reply delivered by several webhooks', () => {
    it.each([
        [
            'arrive together',
            (run: () => Promise<void>) =>
                Promise.all([run(), run(), run(), run()]),
        ],
        [
            'are processed one after another',
            async (run: () => Promise<void>) => {
                for (let i = 0; i < 4; i++) await run();
            },
        ],
    ])(
        'answers once when 4 deliveries of the same note %s',
        async (_, deliverFourTimes) => {
            const {
                useCase,
                conversationAgentUseCase,
                codeManagementService,
            } = setup();

            await deliverFourTimes(() => useCase.execute(delivery()));

            expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
            expect(
                codeManagementService.createResponseToComment,
            ).toHaveBeenCalledTimes(1);
            // The extra deliveries stop before any provider call.
            expect(
                codeManagementService.getPullRequestReviewComment,
            ).toHaveBeenCalledTimes(1);
        },
    );

    it('marks the comment processed once answered', async () => {
        const { useCase, inbox } = setup();

        await useCase.execute(delivery());

        expect([...inbox.rows.values()]).toEqual(['PROCESSED']);
    });

    it('lets a resent delivery retry a comment whose answer failed', async () => {
        const { useCase, conversationAgentUseCase, inbox } = setup();
        conversationAgentUseCase.execute.mockRejectedValueOnce(
            new Error('provider 503'),
        );

        await useCase.execute(delivery());
        expect(inbox.release).toHaveBeenCalledTimes(1);
        expect(inbox.complete).not.toHaveBeenCalled();

        // The admin resends the webhook from the platform.
        await useCase.execute(delivery());
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(2);
        expect([...inbox.rows.values()]).toEqual(['PROCESSED']);
    });

    it('gives the comment back when the answer could not be posted', async () => {
        const { useCase, codeManagementService, inbox } = setup();
        codeManagementService.createResponseToComment.mockRejectedValueOnce(
            new Error('gitlab 500'),
        );

        await useCase.execute(delivery());

        expect(inbox.release).toHaveBeenCalledTimes(1);
        expect(inbox.complete).not.toHaveBeenCalled();
    });

    it('lets a resend answer once the missing integration is set up', async () => {
        const { useCase, codeManagementService, conversationAgentUseCase, inbox } =
            setup();
        codeManagementService.findTeamAndOrganizationIdByConfigKey.mockResolvedValueOnce(
            null,
        );

        await useCase.execute(delivery());
        expect(inbox.release).toHaveBeenCalledTimes(1);
        expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();

        await useCase.execute(delivery());
        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('answers an edited comment again, as before', async () => {
        const { useCase, conversationAgentUseCase } = setup();

        await useCase.execute(delivery('first', '2026-09-28 19:01:00 UTC'));
        await useCase.execute(delivery('edited', '2026-09-28 19:05:00 UTC'));

        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('keys GitHub deliveries by repository, comment and update time', async () => {
        const inbox = fakeInbox();
        const { useCase } = setup(inbox);
        const github = (updatedAt: string) =>
            ({
                event: 'pull_request_review_comment',
                platformType: PlatformType.GITHUB,
                payload: {
                    action: 'created',
                    repository: { id: 4242, name: 'api' },
                    pull_request: {
                        number: 7,
                        head: { ref: 'feat/x' },
                        base: { ref: 'main' },
                    },
                    comment: {
                        id: 900,
                        in_reply_to_id: 555,
                        body: 'why?',
                        updated_at: updatedAt,
                    },
                    sender: { id: 'u1', login: 'dev' },
                },
            }) as any;

        await Promise.all([
            useCase.execute(github('2026-09-28T19:01:00Z')),
            useCase.execute(github('2026-09-28T19:01:00Z')),
        ]);

        expect(inbox.claim.mock.calls.map((c) => c[1])).toEqual([
            'GITHUB:4242:7::900:2026-09-28T19:01:00Z',
            'GITHUB:4242:7::900:2026-09-28T19:01:00Z',
        ]);
        expect([...inbox.rows.keys()]).toHaveLength(1);
    });

    it('does not mix up Azure comments that share an id in different threads', async () => {
        // No timestamp in the payload: only the thread keeps them apart.
        const inbox = fakeInbox();
        const { useCase } = setup(inbox);
        const azure = (threadId: number) =>
            ({
                event: 'ms.vss-code.git-pullrequest-comment-event',
                platformType: PlatformType.AZURE_REPOS,
                payload: {
                    resource: {
                        comment: {
                            id: 2,
                            content: 'why?',
                            _links: {
                                threads: {
                                    href: `https://dev.azure.com/o/p/_apis/git/repositories/r/pullRequests/5/threads/${threadId}`,
                                },
                            },
                        },
                        pullRequest: {
                            pullRequestId: 5,
                            repository: { id: 'repo-az', name: 'api' },
                        },
                    },
                },
            }) as any;

        await useCase.execute(azure(11));
        await useCase.execute(azure(12));
        await useCase.execute(azure(12));

        const keys = inbox.claim.mock.calls.map((c) => c[1]);
        expect(new Set(keys).size).toBe(2);
        expect(keys[1]).toBe(keys[2]);
    });

    it('does not claim on platforms without a comment id to key on', async () => {
        const inbox = fakeInbox();
        const { useCase } = setup(inbox);

        await useCase.execute({
            event: 'issue_comment',
            platformType: PlatformType.FORGEJO,
            payload: { action: 'created', comment: { id: 1, body: '@kody hi' } },
        } as any);

        expect(inbox.claim).not.toHaveBeenCalled();
    });

    it('answers when the claim cannot be made (a duplicate beats silence)', async () => {
        const inbox = {
            claim: jest.fn().mockRejectedValue(new Error('db down')),
            complete: jest.fn(),
        };
        const { useCase, conversationAgentUseCase } = setup(inbox);

        await useCase.execute(delivery());

        expect(conversationAgentUseCase.execute).toHaveBeenCalledTimes(1);
        expect(inbox.complete).not.toHaveBeenCalled();
    });
});
