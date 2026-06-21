jest.mock(
    '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case',
    () => ({
        GenerateIssuesFromPrClosedUseCase: class GenerateIssuesFromPrClosedUseCase {},
    }),
);
jest.mock(
    '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case',
    () => ({
        ChatWithKodyFromGitUseCase: class ChatWithKodyFromGitUseCase {},
    }),
);

import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
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
import { ForgejoPullRequestHandler } from './forgejoPullRequest.handler';

describe('ForgejoPullRequestHandler push events', () => {
    let handler: ForgejoPullRequestHandler;
    let webhookContextService: { getContext: jest.Mock };
    let codeManagementService: {
        getPullRequests: jest.Mock;
        getCommitsForPullRequestForCodeReview: jest.Mock;
    };
    let outboxRepository: { create: jest.Mock };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    function makeForgejoPushPayload() {
        return {
            ref: 'refs/heads/feature/force-push',
            before: 'old-head-sha',
            after: 'new-head-sha',
            compare_url:
                'https://git.example.com/org/test-repo/compare/old...new',
            commits: [],
            total_commits: 1,
            head_commit: null,
            repository: {
                id: 12345,
                name: 'test-repo',
                full_name: 'org/test-repo',
            },
            pusher: {
                name: 'Pusher',
                email: 'pusher@example.com',
                username: 'pusher',
            },
            sender: {
                id: 9001,
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
        codeManagementService = {
            getPullRequests: jest.fn().mockResolvedValue([
                {
                    number: 42,
                    state: PullRequestState.OPENED,
                    head: {
                        ref: 'feature/force-push',
                        sha: 'new-head-sha',
                    },
                },
            ]),
            getCommitsForPullRequestForCodeReview: jest
                .fn()
                .mockResolvedValue([{ sha: 'new-head-sha' }]),
        };
        outboxRepository = {
            create: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ForgejoPullRequestHandler,
                {
                    provide: SavePullRequestUseCase,
                    useValue: { execute: jest.fn() },
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
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: EventEmitter2,
                    useValue: { emit: jest.fn() },
                },
                {
                    provide: EnqueueCodeReviewJobUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: EnqueueImplementationCheckUseCase,
                    useValue: { execute: jest.fn() },
                },
                {
                    provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
                    useValue: outboxRepository,
                },
            ],
        }).compile();

        handler = module.get<ForgejoPullRequestHandler>(
            ForgejoPullRequestHandler,
        );
    });

    it('writes force_pushed invalidation when push removes previous head from PR commits', async () => {
        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload: makeForgejoPushPayload(),
        } as any);

        expect(codeManagementService.getPullRequests).toHaveBeenCalledWith(
            {
                organizationAndTeamData,
                repository: {
                    id: '12345',
                    name: 'org/test-repo',
                },
                filters: {
                    state: PullRequestState.OPENED,
                    branch: 'feature/force-push',
                },
            },
            PlatformType.FORGEJO,
        );
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
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload: makeForgejoPushPayload(),
        } as any);

        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes when context is missing', async () => {
        webhookContextService.getContext.mockResolvedValue(null);

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload: makeForgejoPushPayload(),
        } as any);

        expect(codeManagementService.getPullRequests).not.toHaveBeenCalled();
        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes when before and after are equal', async () => {
        const payload = makeForgejoPushPayload();
        payload.after = payload.before;

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload,
        } as any);

        expect(codeManagementService.getPullRequests).not.toHaveBeenCalled();
        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes for tag refs', async () => {
        const payload = makeForgejoPushPayload();
        payload.ref = 'refs/tags/v1.2.3';

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload,
        } as any);

        expect(codeManagementService.getPullRequests).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes for branch deletion payloads', async () => {
        const payload = makeForgejoPushPayload();
        payload.after = '0000000000000000000000000000000000000000';

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload,
        } as any);

        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes for new branch pushes (before is zero SHA)', async () => {
        const payload = makeForgejoPushPayload();
        payload.before = '0000000000000000000000000000000000000000';

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload,
        } as any);

        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('does not evaluate force pushes when push after sha does not match current PR head', async () => {
        codeManagementService.getPullRequests.mockResolvedValue([
            {
                number: 42,
                state: PullRequestState.OPENED,
                head: {
                    ref: 'feature/force-push',
                    sha: 'different-head-sha',
                },
            },
        ]);

        await handler.execute({
            event: 'push',
            platformType: PlatformType.FORGEJO,
            payload: makeForgejoPushPayload(),
        } as any);

        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).not.toHaveBeenCalled();
        expect(outboxRepository.create).not.toHaveBeenCalled();
    });
});
