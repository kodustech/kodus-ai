import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { EnqueueCodeReviewJobUseCase } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import {
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
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
import { GitHubPullRequestHandler } from './githubPullRequest.handler';

describe('GitHubPullRequestHandler', () => {
    let handler: GitHubPullRequestHandler;
    let webhookContextService: { getContext: jest.Mock };
    let savePullRequestUseCase: { execute: jest.Mock };
    let codeManagementService: {
        getCommitsForPullRequestForCodeReview: jest.Mock;
        getPullRequest: jest.Mock;
    };
    let generateIssuesFromPrClosedUseCase: { execute: jest.Mock };
    let enqueueCodeReviewJobUseCase: { execute: jest.Mock };
    let enqueueImplementationCheckUseCase: { execute: jest.Mock };
    let outboxRepository: { create: jest.Mock };

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
});
