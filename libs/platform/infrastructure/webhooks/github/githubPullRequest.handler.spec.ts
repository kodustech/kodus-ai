import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { GenerateIssuesFromPrClosedUseCase } from '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import {
    SANDBOX_INVALIDATE_ROUTING_KEY,
    SandboxInvalidatePayload,
} from '@libs/sandbox/domain/events/sandbox-invalidate.event';
import { SavePullRequestUseCase } from '@libs/platformData/application/use-cases/pullRequests/save.use-case';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { CodeManagementService } from '../../adapters/services/codeManagement.service';
import { SyncAllRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/sync-all-repositories.use-case';
import { GitHubPullRequestHandler } from './githubPullRequest.handler';
import { CarryReviewCheckToMergeQueueUseCase } from '@libs/platform/application/use-cases/codeManagement/carry-review-check-to-merge-queue.use-case';

describe('GitHubPullRequestHandler', () => {
    let handler: GitHubPullRequestHandler;
    let webhookContextService: { getContext: jest.Mock };
    let savePullRequestUseCase: { execute: jest.Mock };
    let codeManagementService: {
        getCommitsForPullRequestForCodeReview: jest.Mock;
        getPullRequest: jest.Mock;
        isOwnAccount: jest.Mock;
        getReviewStatusByPullRequest: jest.Mock;
    };
    let generateIssuesFromPrClosedUseCase: { execute: jest.Mock };
    let enqueueCodeReviewJobUseCase: { execute: jest.Mock };
    let enqueueImplementationCheckUseCase: { execute: jest.Mock };
    let outboxRepository: { create: jest.Mock };
    let carryReviewCheckToMergeQueueUseCase: { execute: jest.Mock };
    let syncAllRepositoriesUseCase: { syncInstallation: jest.Mock };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    function makeGitHubPullRequestWebhookPayload(action: string) {
        return {
            action,
            before: 'old-head-sha',
            after: 'new-head-sha',
            pull_request: {
                number: 42,
                html_url: 'https://github.com/org/test-repo/pull/42',
                merged: false,
                head: {
                    sha: 'new-head-sha',
                },
                base: {
                    ref: 'main',
                },
            },
            repository: {
                id: 12345,
                name: 'test-repo',
                full_name: 'org/test-repo',
            },
        };
    }

    beforeEach(async () => {
        webhookContextService = {
            getContext: jest.fn().mockResolvedValue({
                organizationAndTeamData,
                teamAutomationId: 'ta-1',
            }),
        };
        savePullRequestUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        codeManagementService = {
            getCommitsForPullRequestForCodeReview: jest
                .fn()
                .mockResolvedValue([]),
            getPullRequest: jest.fn().mockResolvedValue({
                number: 42,
                head: { ref: 'feature', sha: 'new-head-sha' },
                base: { ref: 'main', sha: 'base-sha' },
            }),
            isOwnAccount: jest.fn().mockResolvedValue(false),
            getReviewStatusByPullRequest: jest.fn().mockResolvedValue(null),
        };
        generateIssuesFromPrClosedUseCase = {
            execute: jest.fn(),
        };
        enqueueCodeReviewJobUseCase = {
            execute: jest.fn().mockResolvedValue('job-123'),
        };
        enqueueImplementationCheckUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        outboxRepository = {
            create: jest.fn().mockResolvedValue(undefined),
        };
        carryReviewCheckToMergeQueueUseCase = {
            execute: jest.fn().mockResolvedValue({ carried: true }),
        };
        syncAllRepositoriesUseCase = {
            syncInstallation: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GitHubPullRequestHandler,
                {
                    provide: SavePullRequestUseCase,
                    useValue: savePullRequestUseCase,
                },
                {
                    provide: WebhookContextService,
                    useValue: webhookContextService,
                },
                {
                    provide: ChatWithKodyFromGitUseCase,
                    useValue: {},
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementService,
                },
                {
                    provide: GenerateIssuesFromPrClosedUseCase,
                    useValue: generateIssuesFromPrClosedUseCase,
                },
                {
                    provide: EventEmitter2,
                    useValue: { emit: jest.fn() },
                },
                {
                    provide: EnqueueCodeReviewJobUseCase,
                    useValue: enqueueCodeReviewJobUseCase,
                },
                {
                    provide: EnqueueImplementationCheckUseCase,
                    useValue: enqueueImplementationCheckUseCase,
                },
                {
                    provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
                    useValue: outboxRepository,
                },
                {
                    provide: CarryReviewCheckToMergeQueueUseCase,
                    useValue: carryReviewCheckToMergeQueueUseCase,
                },
                {
                    provide: SyncAllRepositoriesUseCase,
                    useValue: syncAllRepositoriesUseCase,
                },
            ],
        }).compile();

        handler = module.get<GitHubPullRequestHandler>(
            GitHubPullRequestHandler,
        );
    });

    it('writes force_pushed invalidation when synchronize removes previous head from PR commits', async () => {
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            [{ sha: 'new-head-sha' }],
        );

        await handler.execute({
            event: 'pull_request',
            platformType: PlatformType.GITHUB,
            payload: makeGitHubPullRequestWebhookPayload('synchronize'),
        } as any);

        expect(outboxRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                routingKey: SANDBOX_INVALIDATE_ROUTING_KEY,
                payload: expect.objectContaining<SandboxInvalidatePayload>({
                    prKey: 'org-1:12345:42',
                    reason: 'force_pushed',
                }),
            }),
        );
    });

    it('does not write force_pushed invalidation when old head is still in PR commits', async () => {
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            [{ sha: 'old-head-sha' }, { sha: 'new-head-sha' }],
        );

        await handler.execute({
            event: 'pull_request',
            platformType: PlatformType.GITHUB,
            payload: makeGitHubPullRequestWebhookPayload('synchronize'),
        } as any);

        expect(outboxRepository.create).not.toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    reason: 'force_pushed',
                }),
            }),
        );
    });

    it('does not write force_pushed invalidation when payload.before is missing', async () => {
        const payload = makeGitHubPullRequestWebhookPayload('synchronize');
        delete payload.before;

        await handler.execute({
            event: 'pull_request',
            platformType: PlatformType.GITHUB,
            payload,
        } as any);

        expect(outboxRepository.create).not.toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    reason: 'force_pushed',
                }),
            }),
        );
    });

    it('preserves existing closed to pr_closed invalidation behavior', async () => {
        await handler.execute({
            event: 'pull_request',
            platformType: PlatformType.GITHUB,
            payload: makeGitHubPullRequestWebhookPayload('closed'),
        } as any);

        expect(generateIssuesFromPrClosedUseCase.execute).toHaveBeenCalled();
        expect(outboxRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                routingKey: SANDBOX_INVALIDATE_ROUTING_KEY,
                payload: expect.objectContaining<SandboxInvalidatePayload>({
                    prKey: 'org-1:12345:42',
                    reason: 'pr_closed',
                }),
            }),
        );
    });

    describe('`@kody -v <agent>` comments', () => {
        const comment = (body: string) => ({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                issue: { number: 42, pull_request: {} },
                comment: { id: 777, body },
                repository: {
                    id: 12345,
                    name: 'test-repo',
                    full_name: 'org/test-repo',
                },
                sender: { id: 1 },
            },
        });

        it('runs a review of only that custom agent', async () => {
            await handler.execute(comment('@kody -v ledger-rules') as any);

            expect(enqueueCodeReviewJobUseCase.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    codeManagementPayload: expect.objectContaining({
                        origin: 'command',
                        onlyCustomAgent: 'ledger-rules',
                        triggerCommentId: '777',
                    }),
                }),
            );
        });

        it('leaves `@kody -v business-logic` to the business validation', async () => {
            await handler
                .execute(comment('@kody -v business-logic') as any)
                .catch(() => undefined);

            expect(enqueueCodeReviewJobUseCase.execute).not.toHaveBeenCalled();
        });

        it('sets no agent on a plain review command', async () => {
            await handler.execute(comment('@kody start-review') as any);

            const [{ codeManagementPayload }] =
                enqueueCodeReviewJobUseCase.execute.mock.calls[0];
            expect(codeManagementPayload.onlyCustomAgent).toBeUndefined();
        });
    });
    describe('merge queue pushes', () => {
        const queueRef =
            'refs/heads/gh-readonly-queue/main/pr-42-b849a34be3d6e2b91399a6ddca1a4d3ea153839d';
        const pushParams = (payload: Record<string, unknown>) => ({
            platformType: PlatformType.GITHUB,
            event: 'push',
            payload: {
                after: '8abdf355fd81b893471909152d4c95964c449407',
                repository: {
                    id: 12345,
                    name: 'test-repo',
                    full_name: 'org/test-repo',
                },
                ...payload,
            },
        });

        it('accepts a push that creates a merge queue branch', () => {
            expect(
                handler.canHandle(pushParams({ ref: queueRef, created: true })),
            ).toBe(true);
        });

        it.each([
            ['an ordinary branch push', { ref: 'refs/heads/main' }],
            ['a merge queue branch deletion', { ref: queueRef, deleted: true }],
        ])('still ignores %s', (_label, payload) => {
            expect(handler.canHandle(pushParams(payload))).toBe(false);
        });

        it('hands the queue push to the carry use case and starts no review', async () => {
            const params = pushParams({ ref: queueRef, created: true });

            await handler.execute(params);

            expect(
                carryReviewCheckToMergeQueueUseCase.execute,
            ).toHaveBeenCalledWith(params);
            expect(savePullRequestUseCase.execute).not.toHaveBeenCalled();
            expect(enqueueCodeReviewJobUseCase.execute).not.toHaveBeenCalled();
        });
    });

    describe('new repository events', () => {
        it.each([
            ['installation_repositories', 'added'],
            ['repository', 'created'],
        ])(
            'syncs the teams on the installation for %s/%s',
            async (event, action) => {
                const params = {
                    platformType: PlatformType.GITHUB,
                    event,
                    payload: { action, installation: { id: 42 } },
                };

                expect(handler.canHandle(params as any)).toBe(true);
                await handler.execute(params as any);

                expect(
                    syncAllRepositoriesUseCase.syncInstallation,
                ).toHaveBeenCalledWith('42');
                expect(savePullRequestUseCase.execute).not.toHaveBeenCalled();
            },
        );

        it('ignores a repository event other than creation', () => {
            expect(
                handler.canHandle({
                    platformType: PlatformType.GITHUB,
                    event: 'repository',
                    payload: { action: 'archived', installation: { id: 42 } },
                } as any),
            ).toBe(false);
        });
    });

    describe('review re-request', () => {
        const kody = { login: 'kody-ai[bot]', node_id: 'BOT_kody' };
        const reviewRequested = (requested: Record<string, unknown>) => ({
            platformType: PlatformType.GITHUB,
            event: 'pull_request',
            correlationId: 'corr-1',
            payload: {
                ...makeGitHubPullRequestWebhookPayload('review_requested'),
                ...requested,
            },
        });

        beforeEach(() => {
            codeManagementService.isOwnAccount.mockResolvedValue(true);
            codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                PullRequestReviewState.CHANGES_REQUESTED,
            );
        });

        it('starts a review as a command on a PR Kody already reviewed', async () => {
            const params = reviewRequested({ requested_reviewer: kody });

            expect(handler.canHandle(params as any)).toBe(true);
            await handler.execute(params as any);

            expect(codeManagementService.isOwnAccount).toHaveBeenCalledWith(
                { organizationAndTeamData, account: kody },
                PlatformType.GITHUB,
            );
            expect(
                codeManagementService.getReviewStatusByPullRequest,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                repository: { id: '12345', name: 'test-repo' },
                prNumber: 42,
            });
            // Saved as the event it is; only the review job is a command.
            expect(savePullRequestUseCase.execute).toHaveBeenCalledWith(params);
            expect(enqueueCodeReviewJobUseCase.execute).toHaveBeenCalledTimes(
                1,
            );
            expect(enqueueCodeReviewJobUseCase.execute).toHaveBeenCalledWith({
                codeManagementPayload: {
                    ...params.payload,
                    action: 'synchronize',
                    origin: 'command',
                },
                event: 'pull_request',
                platformType: PlatformType.GITHUB,
                organizationAndTeamData,
                teamAutomationId: 'ta-1',
                correlationId: 'corr-1',
            });
            // A click is not a push: nothing was implemented or force-pushed.
            expect(
                enqueueImplementationCheckUseCase.execute,
            ).not.toHaveBeenCalled();
            expect(outboxRepository.create).not.toHaveBeenCalled();
        });

        // GitHub sends the same event when Kody's account is asked for the
        // first time (CODEOWNERS, a reviewer picked while opening the PR).
        // There the `opened` event decides, with every guard a command skips.
        it.each([PullRequestReviewState.NONE, null])(
            'starts nothing on a PR Kody has not reviewed yet (%s)',
            async (status) => {
                codeManagementService.getReviewStatusByPullRequest.mockResolvedValue(
                    status,
                );

                await handler.execute(
                    reviewRequested({ requested_reviewer: kody }) as any,
                );

                expect(savePullRequestUseCase.execute).not.toHaveBeenCalled();
                expect(
                    enqueueCodeReviewJobUseCase.execute,
                ).not.toHaveBeenCalled();
            },
        );

        it('starts nothing when the reviewer asked is somebody else', async () => {
            codeManagementService.isOwnAccount.mockResolvedValue(false);
            const params = reviewRequested({
                requested_reviewer: { login: 'alice', node_id: 'U_alice' },
            });

            expect(handler.canHandle(params as any)).toBe(true);
            await handler.execute(params as any);

            expect(
                codeManagementService.getReviewStatusByPullRequest,
            ).not.toHaveBeenCalled();
            expect(savePullRequestUseCase.execute).not.toHaveBeenCalled();
            expect(enqueueCodeReviewJobUseCase.execute).not.toHaveBeenCalled();
        });

        it('does not handle a request made to a team', () => {
            expect(
                handler.canHandle(
                    reviewRequested({
                        requested_team: { slug: 'backend' },
                    }) as any,
                ),
            ).toBe(false);
        });

        it('starts nothing on a repository Kody does not review', async () => {
            webhookContextService.getContext.mockResolvedValue(null);

            await handler.execute(
                reviewRequested({ requested_reviewer: kody }) as any,
            );

            expect(codeManagementService.isOwnAccount).not.toHaveBeenCalled();
            expect(enqueueCodeReviewJobUseCase.execute).not.toHaveBeenCalled();
        });

        // Nearly every review request is for somebody else: one whose owner
        // cannot be told must not go through the job's retries.
        it('drops the event when it cannot tell whose request it is', async () => {
            codeManagementService.isOwnAccount.mockRejectedValue(
                new Error('rate limited'),
            );

            await expect(
                handler.execute(
                    reviewRequested({ requested_reviewer: kody }) as any,
                ),
            ).resolves.toBeUndefined();
            expect(enqueueCodeReviewJobUseCase.execute).not.toHaveBeenCalled();
        });

        it('fails the event when the review Kody was asked for cannot be queued', async () => {
            const failed = new Error('queue down');
            enqueueCodeReviewJobUseCase.execute.mockRejectedValue(failed);

            await expect(
                handler.execute(
                    reviewRequested({ requested_reviewer: kody }) as any,
                ),
            ).rejects.toBe(failed);
        });
    });
});
