jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({ id: 'TR-test', metadata: {} })),
}));

jest.mock('./implicit-reply', () => ({
    ...jest.requireActual('./implicit-reply'),
    classifyReplyAddressedToKody: jest.fn(),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ValidationErrorType } from '@libs/ee/shared/services/permissionValidation.service';

import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';
import { classifyReplyAddressedToKody } from './implicit-reply';

const classify = classifyReplyAddressedToKody as jest.Mock;

// buildPrKey rejects a non-UUID organization id.
const ORG = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const MARKER = '<!-- kody-codereview -->';
const ANSWER_MARKER = `${MARKER}\n<!-- kody-conversation -->`;

function setup(comments: any[]) {
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
    const permissionValidationService = {
        validateExecutionPermissions: jest
            .fn()
            .mockResolvedValue({ allowed: true }),
        resolveTaskSlot: jest.fn().mockResolvedValue(undefined),
    };
    const useCase = new ChatWithKodyFromGitUseCase(
        codeManagementService as any,
        conversationAgentUseCase as any,
        { execute: jest.fn() } as any,
        permissionValidationService as any,
        {
            acquire: jest.fn().mockResolvedValue({
                sandbox: { type: 'null' },
                leaseId: 'lease',
            }),
            release: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
            findByNumberAndRepositoryId: jest.fn().mockResolvedValue(null),
        } as any,
    );

    return {
        useCase,
        codeManagementService,
        conversationAgentUseCase,
        permissionValidationService,
    };
}

const at = (minute: number) =>
    `2026-09-24T10:${String(minute).padStart(2, '0')}:00Z`;

// ── GitHub ──────────────────────────────────────────────────────────────────

const githubKodyRoot = {
    id: 555,
    body: `This query can return duplicate rows. ${MARKER}`,
    user: { login: 'kodus-ai[bot]', type: 'Bot' },
    created_at: at(0),
};

function githubReply(
    id: number,
    body: string,
    login: string,
    minute: number,
    type = 'User',
) {
    return {
        id,
        in_reply_to_id: 555,
        body,
        user: { login, type },
        created_at: at(minute),
    };
}

function githubParams(comment: { id: number; body: string }, inReplyTo = 555) {
    return {
        event: 'pull_request_review_comment',
        platformType: PlatformType.GITHUB,
        payload: {
            action: 'created',
            repository: { id: 'repo-1', name: 'billing-api' },
            pull_request: {
                number: 812,
                head: { ref: 'feat/x' },
                base: { ref: 'main' },
            },
            comment: { ...comment, in_reply_to_id: inReplyTo },
            sender: { id: 'user-1', login: 'dev-one' },
        },
    } as any;
}

describe('ChatWithKodyFromGitUseCase — replies without @kody (#1946)', () => {
    beforeEach(() => {
        classify.mockReset();
    });

    describe('GitHub', () => {
        it('answers a reply in a Kody thread when the classifier says it is for Kody', async () => {
            classify.mockResolvedValue(true);
            const reply = githubReply(
                900,
                'the key is unique, so no',
                'dev-one',
                1,
            );
            const { useCase, conversationAgentUseCase, codeManagementService } =
                setup([githubKodyRoot, reply]);

            await useCase.execute(githubParams(reply));

            expect(classify).toHaveBeenCalledWith(
                expect.objectContaining({
                    thread: [
                        expect.objectContaining({ id: 555, isKody: true }),
                        expect.objectContaining({
                            id: 900,
                            isKody: false,
                            isBot: false,
                            body: 'the key is unique, so no',
                        }),
                    ],
                }),
            );
            expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prepareContext: expect.objectContaining({
                        userQuestion: 'the key is unique, so no',
                    }),
                }),
            );
            expect(
                codeManagementService.createResponseToComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    inReplyToId: 900,
                    body: `an answer\n\n${ANSWER_MARKER}`,
                }),
            );
        });

        it('stays quiet when the classifier says the reply is for someone else', async () => {
            classify.mockResolvedValue(false);
            const reply = githubReply(
                900,
                '@bob did we pick 2s on purpose?',
                'alice',
                1,
            );
            const { useCase, conversationAgentUseCase, codeManagementService } =
                setup([githubKodyRoot, reply]);

            await useCase.execute(githubParams(reply));

            expect(classify).toHaveBeenCalled();
            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
            expect(
                codeManagementService.createResponseToComment,
            ).not.toHaveBeenCalled();
            expect(
                codeManagementService.addReactionToComment,
            ).not.toHaveBeenCalled();
        });

        it('stays quiet when the classifier fails', async () => {
            classify.mockRejectedValue(new Error('provider 503'));
            const reply = githubReply(900, 'why?', 'dev-one', 1);
            const { useCase, conversationAgentUseCase } = setup([
                githubKodyRoot,
                reply,
            ]);

            await useCase.execute(githubParams(reply));

            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
        });

        it('classifies on the conversation task slot', async () => {
            classify.mockResolvedValue(false);
            const reply = githubReply(900, 'why?', 'dev-one', 1);
            const { useCase, permissionValidationService } = setup([
                githubKodyRoot,
                reply,
            ]);
            const slot = { provider: 'anthropic', model: 'claude' };
            permissionValidationService.resolveTaskSlot.mockResolvedValue(slot);

            await useCase.execute(githubParams(reply));

            expect(
                permissionValidationService.resolveTaskSlot,
            ).toHaveBeenCalledWith(
                { organizationId: ORG, teamId: TEAM },
                'conversation',
            );
            expect(classify).toHaveBeenCalledWith(
                expect.objectContaining({ byokConfig: slot }),
            );
        });

        it('ignores a reply in a thread a person started', async () => {
            const humanRoot = {
                id: 555,
                body: 'should this be async?',
                user: { login: 'alice', type: 'User' },
                created_at: at(0),
            };
            const reply = githubReply(900, 'yes', 'bob', 1);
            const { useCase, conversationAgentUseCase } = setup([
                humanRoot,
                reply,
            ]);

            await useCase.execute(githubParams(reply));

            expect(classify).not.toHaveBeenCalled();
            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
        });

        it('never answers its own reply, even under an unknown login', async () => {
            const kodyAnswer = githubReply(
                901,
                `It can, when the join fans out.\n\n${MARKER}`,
                'acme-ci',
                2,
            );
            const { useCase, conversationAgentUseCase } = setup([
                githubKodyRoot,
                githubReply(900, 'why?', 'dev-one', 1),
                kodyAnswer,
            ]);

            await useCase.execute(githubParams(kodyAnswer));

            expect(classify).not.toHaveBeenCalled();
            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
        });

        it('keeps the @kody path as it is: no classifier', async () => {
            const reply = githubReply(900, '@kody why?', 'dev-one', 1);
            const { useCase, conversationAgentUseCase } = setup([
                githubKodyRoot,
                reply,
            ]);

            await useCase.execute(githubParams(reply));

            expect(classify).not.toHaveBeenCalled();
            expect(conversationAgentUseCase.execute).toHaveBeenCalled();
        });

        it('stays quiet instead of posting the BYOK pointer when the plan blocks', async () => {
            const reply = githubReply(900, 'why?', 'dev-one', 1);
            const {
                useCase,
                codeManagementService,
                permissionValidationService,
            } = setup([githubKodyRoot, reply]);
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: ValidationErrorType.BYOK_REQUIRED,
                },
            );

            await useCase.execute(githubParams(reply));

            expect(classify).not.toHaveBeenCalled();
            expect(
                codeManagementService.createResponseToComment,
            ).not.toHaveBeenCalled();
        });

        describe('bot loop cap', () => {
            // Kody root, then `pairs` rounds of (bot, Kody), then a new bot reply.
            function botLoop(pairs: number) {
                const comments: any[] = [githubKodyRoot];
                let id = 600;
                let minute = 1;
                comments.push(githubReply(id++, 'fixed?', 'dev-one', minute++));
                for (let i = 0; i < pairs; i++) {
                    comments.push(
                        githubReply(
                            id++,
                            'done, check again',
                            'devin-ai-integration[bot]',
                            minute++,
                            'Bot',
                        ),
                    );
                    comments.push(
                        githubReply(
                            id++,
                            `looks good ${MARKER}`,
                            'kodus-ai[bot]',
                            minute++,
                            'Bot',
                        ),
                    );
                }
                const newest = githubReply(
                    id,
                    'check again',
                    'devin-ai-integration[bot]',
                    minute,
                    'Bot',
                );
                comments.push(newest);
                return { comments, newest };
            }

            it('lets a bot through below the cap', async () => {
                classify.mockResolvedValue(true);
                const { comments, newest } = botLoop(4);
                const { useCase } = setup(comments);

                await useCase.execute(githubParams(newest));

                expect(classify).toHaveBeenCalled();
            });

            it('stops after 5 Kody replies to bots with no human in between', async () => {
                const { comments, newest } = botLoop(5);
                const { useCase, conversationAgentUseCase } = setup(comments);

                await useCase.execute(githubParams(newest));

                expect(classify).not.toHaveBeenCalled();
                expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
            });
        });
    });

    it('GitLab: answers a reply in a Kody discussion', async () => {
        classify.mockResolvedValue(true);
        const originalCommit = {
            id: 20,
            body: `Missing null check. ${MARKER}`,
        };
        const { useCase, conversationAgentUseCase, codeManagementService } =
            setup([
                {
                    id: 21,
                    body: 'can it be null here?',
                    createdAt: at(1),
                    discussionId: 'd1',
                    originalCommit,
                    author: { id: 7, username: 'alice', name: 'Alice' },
                },
                {
                    id: 20,
                    body: originalCommit.body,
                    createdAt: at(0),
                    discussionId: 'd1',
                    originalCommit,
                    author: { id: 1, username: 'kody', name: 'Kody' },
                },
            ]);

        await useCase.execute({
            event: 'note',
            platformType: PlatformType.GITLAB,
            payload: {
                event_type: 'note',
                object_attributes: {
                    id: 21,
                    note: 'can it be null here?',
                    discussion_id: 'd1',
                    type: 'DiffNote',
                },
                project: {
                    id: 'repo-1',
                    name: 'api',
                    path_with_namespace: 'acme/api',
                },
                merge_request: { iid: 5 },
                user: { id: 7, name: 'Alice' },
            },
        } as any);

        expect(classify).toHaveBeenCalledWith(
            expect.objectContaining({
                thread: [
                    expect.objectContaining({ id: 20, isKody: true }),
                    expect.objectContaining({ id: 21, author: 'Alice' }),
                ],
            }),
        );
        expect(conversationAgentUseCase.execute).toHaveBeenCalled();
        expect(
            codeManagementService.createResponseToComment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ body: `an answer\n\n${ANSWER_MARKER}` }),
        );
    });

    it('Bitbucket: answers a nested reply under a Kody comment, without the HTML marker', async () => {
        classify.mockResolvedValue(true);
        const { useCase, conversationAgentUseCase, codeManagementService } =
            setup([
                {
                    id: 32,
                    body: 'fixed in the last push',
                    createdAt: at(2),
                    parent: { id: 31 },
                    author: { name: 'Bob', username: 'bob' },
                },
                {
                    id: 31,
                    body: 'is this still valid?',
                    createdAt: at(1),
                    parent: { id: 30 },
                    author: { name: 'Alice', username: 'alice' },
                },
                {
                    id: 30,
                    body: '`kody|code-review` `bug` The lock is released early.',
                    createdAt: at(0),
                    author: { name: 'Kody', username: 'kody' },
                },
            ]);
        codeManagementService.createResponseToComment.mockResolvedValue({
            id: 999,
            parent: { id: 32 },
        });

        await useCase.execute({
            event: 'pullrequest:comment_created',
            platformType: PlatformType.BITBUCKET,
            payload: {
                repository: { name: 'api', uuid: '{repo-1}' },
                pullrequest: { id: 7 },
                comment: {
                    id: 32,
                    content: { raw: 'fixed in the last push' },
                    parent: { id: 31 },
                },
                actor: { display_name: 'Bob', uuid: '{u-2}' },
            },
        } as any);

        expect(classify).toHaveBeenCalledWith(
            expect.objectContaining({
                thread: [
                    expect.objectContaining({ id: 30, isKody: true }),
                    expect.objectContaining({ id: 31 }),
                    expect.objectContaining({ id: 32 }),
                ],
            }),
        );
        expect(conversationAgentUseCase.execute).toHaveBeenCalled();
        expect(
            codeManagementService.updateResponseToComment,
        ).toHaveBeenCalledWith(expect.objectContaining({ body: 'an answer' }));
    });

    it('Azure DevOps: answers a reply in a Kody thread', async () => {
        classify.mockResolvedValue(true);
        const { useCase, conversationAgentUseCase } = setup([
            {
                id: 1,
                threadId: 3239,
                body: `Unbounded retry. ${MARKER}`,
                createdAt: at(0),
                author: { id: 'k', name: 'Kody' },
                replies: [
                    {
                        id: 2,
                        threadId: 3239,
                        body: 'false positive, there is a cap upstream',
                        createdAt: at(1),
                        author: { id: 'a', name: 'alice' },
                    },
                ],
            },
        ]);

        await useCase.execute({
            event: 'ms.vss-code.git-pullrequest-comment-event',
            platformType: PlatformType.AZURE_REPOS,
            payload: {
                resource: {
                    comment: {
                        id: 2,
                        content: 'false positive, there is a cap upstream',
                        parentCommentId: 1,
                        author: { displayName: 'alice', id: 'a' },
                        _links: {
                            threads: {
                                href: 'https://dev.azure.com/o/p/_apis/git/repositories/r/pullRequests/55/threads/3239',
                            },
                        },
                    },
                    pullRequest: {
                        pullRequestId: 55,
                        repository: { id: 'repo-1', name: 'api' },
                    },
                },
            },
        } as any);

        expect(classify).toHaveBeenCalledWith(
            expect.objectContaining({
                thread: [
                    expect.objectContaining({ id: 1, isKody: true }),
                    expect.objectContaining({ id: 2, isKody: false }),
                ],
            }),
        );
        expect(conversationAgentUseCase.execute).toHaveBeenCalled();
    });
});
