jest.mock('@libs/core/observability', () => ({
    getObservability: () => ({
        getContext: () => ({ correlationId: 'corr-1' }),
    }),
}));

import { AutomationCodeReviewService } from './automationCodeReview';
import { isPrReviewInProgressError } from '@libs/code-review/domain/errors/pr-review-in-progress.error';

const makePayload = (overrides: Record<string, unknown> = {}) => ({
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'repo-name' },
    pullRequest: { number: 42 },
    branch: 'feature-branch',
    platformType: 'github',
    teamAutomationId: 'team-automation-1',
    action: 'synchronize',
    ...overrides,
});

describe('AutomationCodeReviewService', () => {
    let service: AutomationCodeReviewService;
    let teamAutomationService: Record<string, jest.Mock>;
    let automationService: Record<string, jest.Mock>;
    let automationExecutionService: Record<string, jest.Mock>;
    let organizationService: { findOne: jest.Mock };
    let codeReviewHandlerService: Record<string, jest.Mock>;
    let distributedLockService: { acquire: jest.Mock };
    let lock: { release: jest.Mock; isReleased: jest.Mock };

    beforeEach(() => {
        lock = {
            release: jest.fn().mockResolvedValue(undefined),
            isReleased: jest.fn().mockReturnValue(false),
        };
        teamAutomationService = { register: jest.fn() };
        automationService = { find: jest.fn() };
        automationExecutionService = {
            find: jest.fn().mockResolvedValue([]),
            createCodeReview: jest.fn().mockResolvedValue({
                execution: { uuid: 'execution-1' },
            }),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
            findLatestExecutionByFilters: jest.fn().mockResolvedValue(null),
        };
        organizationService = {
            findOne: jest.fn().mockResolvedValue({ name: 'org-name' }),
        };
        codeReviewHandlerService = {
            handlePullRequest: jest.fn().mockResolvedValue({
                statusInfo: { status: 'success' },
            }),
            notifyCommandReviewRefused: jest.fn().mockResolvedValue(undefined),
        };
        distributedLockService = { acquire: jest.fn().mockResolvedValue(lock) };

        service = new AutomationCodeReviewService(
            teamAutomationService as any,
            automationService as any,
            automationExecutionService as any,
            organizationService as any,
            codeReviewHandlerService as any,
            distributedLockService as any,
        );
    });

    // A refused `@kody review` used to return a string that the caller chain
    // ignores, so the job was marked COMPLETED and the request vanished with
    // no review, no retry and nothing on the PR (#1700). Commands now raise,
    // which lets the job processor reschedule them.
    describe('when the PR lock is already held', () => {
        beforeEach(() => {
            distributedLockService.acquire.mockResolvedValue(null);
        });

        it.each(['command', 'command-force'])(
            'raises so the request can be retried (origin %s)',
            async (origin) => {
                const error = await service
                    .run!(makePayload({ origin, triggerCommentId: 7 }))
                    .catch((raised) => raised);

                expect(isPrReviewInProgressError(error)).toBe(true);
                expect(error.gate).toBe('lock');
                expect(error.target).toEqual(
                    expect.objectContaining({
                        organizationAndTeamData: {
                            organizationId: 'org-1',
                            teamId: 'team-1',
                        },
                        repository: { id: 'repo-1', name: 'repo-name' },
                        pullRequest: { number: 42 },
                        platformType: 'github',
                        triggerCommentId: 7,
                    }),
                );
            },
        );

        it('still drops an automation-triggered run quietly', async () => {
            await expect(
                service.run!(makePayload({ origin: undefined })),
            ).resolves.toBeDefined();
        });

        it('never starts the pipeline', async () => {
            await service
                .run!(makePayload({ origin: 'command' }))
                .catch(() => undefined);

            expect(
                codeReviewHandlerService.handlePullRequest,
            ).not.toHaveBeenCalled();
        });
    });

    // The lock auto-releases after its 60s TTL, so a command arriving later
    // takes it cleanly and is refused by the active-execution check instead.
    // Both gates drop the request, so both have to raise.
    describe('when an execution is already in progress', () => {
        beforeEach(() => {
            automationExecutionService.find.mockResolvedValue([
                { uuid: 'execution-1' },
            ]);
        });

        it('raises so the request can be retried', async () => {
            const error = await service
                .run!(makePayload({ origin: 'command', triggerCommentId: 7 }))
                .catch((raised) => raised);

            expect(isPrReviewInProgressError(error)).toBe(true);
            expect(error.gate).toBe('execution');
            expect(error.target.pullRequest).toEqual({ number: 42 });
        });

        it('still drops an automation-triggered run quietly', async () => {
            await expect(
                service.run!(makePayload({ origin: undefined })),
            ).resolves.toBeDefined();
        });

        it('releases the lock it acquired', async () => {
            await service
                .run!(makePayload({ origin: 'command' }))
                .catch(() => undefined);

            expect(lock.release).toHaveBeenCalled();
        });

        it('does not report the refusal as an execution error', async () => {
            await service
                .run!(makePayload({ origin: 'command' }))
                .catch(() => undefined);

            expect(
                automationExecutionService.updateCodeReview,
            ).not.toHaveBeenCalled();
        });
    });

    // Losing the lock service must not become "the PR is busy" — that would
    // turn an infrastructure blip into an endlessly deferred review.
    describe('when the lock service itself fails', () => {
        it('runs the review anyway', async () => {
            distributedLockService.acquire.mockRejectedValue(
                new Error('postgres unreachable'),
            );

            await service.run!(makePayload({ origin: 'command' }));

            expect(
                codeReviewHandlerService.handlePullRequest,
            ).toHaveBeenCalled();
        });
    });
});
