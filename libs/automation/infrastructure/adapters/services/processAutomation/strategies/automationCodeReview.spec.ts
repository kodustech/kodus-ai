jest.mock('@libs/core/observability', () => ({
    getObservability: () => ({
        getContext: () => ({ correlationId: 'corr-1' }),
    }),
}));

jest.mock('typeorm', () => ({
    MoreThanOrEqual: jest.fn((value) => value),
}));

jest.mock(
    '@libs/code-review/infrastructure/adapters/services/codeReviewHandlerService.service',
    () => ({ CodeReviewHandlerService: class CodeReviewHandlerService {} }),
);

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
                const error = await service.run!(
                    makePayload({ origin, triggerCommentId: 7 }),
                ).catch((raised) => raised);

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

        // Recomputing the deadline from "now" on every retry would let it
        // slide indefinitely, so the only stop left would be the attempt
        // cap — safe today only because the lock TTL is short.
        it('anchors the retry deadline on the holder, not on the collision', async () => {
            const holderCreatedAt = new Date(Date.now() - 12 * 60_000);
            automationExecutionService.find.mockResolvedValue([
                { uuid: 'execution-1', createdAt: holderCreatedAt },
            ]);

            const error = await service.run!(
                makePayload({ origin: 'command' }),
            ).catch((raised) => raised);

            expect(error.holderVisibleUntil).toEqual(
                new Date(holderCreatedAt.getTime() + 30 * 60_000),
            );
        });

        it('falls back to now when the holder has no execution row yet', async () => {
            automationExecutionService.find.mockResolvedValue([]);

            const error = await service.run!(
                makePayload({ origin: 'command' }),
            ).catch((raised) => raised);

            expect(error.holderVisibleUntil.getTime()).toBeGreaterThan(
                Date.now() + 29 * 60_000,
            );
        });

        it('never starts the pipeline', async () => {
            await service.run!(makePayload({ origin: 'command' })).catch(
                () => undefined,
            );

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
            const error = await service.run!(
                makePayload({ origin: 'command', triggerCommentId: 7 }),
            ).catch((raised) => raised);

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
            await service.run!(makePayload({ origin: 'command' })).catch(
                () => undefined,
            );

            expect(lock.release).toHaveBeenCalled();
        });

        it('does not report the refusal as an execution error', async () => {
            await service.run!(makePayload({ origin: 'command' })).catch(
                () => undefined,
            );

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

    describe('failure propagation', () => {
        it('rethrows execution persistence failures without masking the cause', async () => {
            automationExecutionService.createCodeReview.mockRejectedValue(
                new Error('execution database unavailable'),
            );

            await expect(service.run!(makePayload())).rejects.toThrow(
                'execution database unavailable',
            );
            expect(
                codeReviewHandlerService.handlePullRequest,
            ).not.toHaveBeenCalled();
        });

        it('marks validation failures once and raises a permanent failure', async () => {
            const error = await service.run!(
                makePayload({
                    validationError: { errorType: 'invalid-config' },
                }),
            ).catch((raised) => raised);

            expect(error.name).toBe('CodeReviewRunFailedError');
            expect(error.errorClassification).toBe('PERMANENT');
            expect(
                automationExecutionService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
            expect(
                codeReviewHandlerService.handlePullRequest,
            ).not.toHaveBeenCalled();
        });

        it('rethrows handler failures after recording the execution error', async () => {
            codeReviewHandlerService.handlePullRequest.mockRejectedValue(
                new Error('pipeline exploded'),
            );

            await expect(service.run!(makePayload())).rejects.toThrow(
                'pipeline exploded',
            );
            expect(
                automationExecutionService.updateCodeReview,
            ).toHaveBeenCalled();
        });

        it('turns a critical pipeline outcome into a permanent job failure', async () => {
            codeReviewHandlerService.handlePullRequest.mockResolvedValue({
                statusInfo: {
                    status: 'error',
                    message: 'Code review failed: provider unavailable',
                },
            });

            const error = await service.run!(makePayload()).catch(
                (raised) => raised,
            );

            expect(error.name).toBe('CodeReviewRunFailedError');
            expect(error.errorClassification).toBe('PERMANENT');
            expect(
                automationExecutionService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
        });
    });
});
