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
    let enqueueImplementationCheckUseCase: { execute: jest.Mock };
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
            // The execution heartbeat fires on a timer; without this a slow
            // run (the mutation gate's) crashes the test process.
            touchInProgress: jest.fn().mockResolvedValue(undefined),
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
        enqueueImplementationCheckUseCase = {
            execute: jest.fn().mockResolvedValue('job-1'),
        };

        service = new AutomationCodeReviewService(
            teamAutomationService as any,
            automationService as any,
            automationExecutionService as any,
            organizationService as any,
            codeReviewHandlerService as any,
            distributedLockService as any,
            enqueueImplementationCheckUseCase as any,
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

        // Recomputing the deadline from "now" on every retry would let it
        // slide indefinitely, so the only stop left would be the attempt
        // cap — safe today only because the lock TTL is short.
        it('anchors the retry deadline on the holder, not on the collision', async () => {
            const holderCreatedAt = new Date(Date.now() - 12 * 60_000);
            automationExecutionService.find.mockResolvedValue([
                { uuid: 'execution-1', createdAt: holderCreatedAt },
            ]);

            const error = await service
                .run!(makePayload({ origin: 'command' }))
                .catch((raised) => raised);

            expect(error.holderVisibleUntil).toEqual(
                new Date(holderCreatedAt.getTime() + 30 * 60_000),
            );
        });

        it('falls back to now when the holder has no execution row yet', async () => {
            automationExecutionService.find.mockResolvedValue([]);

            const error = await service
                .run!(makePayload({ origin: 'command' }))
                .catch((raised) => raised);

            expect(error.holderVisibleUntil.getTime()).toBeGreaterThan(
                Date.now() + 29 * 60_000,
            );
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

    // A worker killed mid-review (deploy, OOM) never writes a terminal
    // status, so its row stays IN_PROGRESS. The gate used to trust that row
    // for 30 minutes from its creation, refusing `@kody start-review` with
    // "already reviewing" while nothing ran. Liveness now comes from a
    // heartbeat the running review keeps writing to the row.
    describe('when an in-progress row was left by a review that died', () => {
        const minutesAgo = (minutes: number) =>
            new Date(Date.now() - minutes * 60_000);

        // Evaluates the gate's filter the way Postgres would, so the test
        // exercises the query the gate actually sends.
        const matches = (row: Record<string, any>, filter: any) =>
            Object.entries(filter).every(([key, expected]: [string, any]) => {
                if (expected?.type === 'moreThanOrEqual') {
                    return row[key] >= expected.value;
                }
                if (key === 'status') {
                    return row.status === expected;
                }
                return true;
            });

        const withRows = (rows: Array<Record<string, any>>) =>
            automationExecutionService.find.mockImplementation(
                async (filter: any) =>
                    rows.filter((row) => matches(row, filter)),
            );

        it('does not block a new review once the row stopped heartbeating', async () => {
            withRows([
                {
                    uuid: 'dead-execution',
                    status: 'in_progress',
                    createdAt: minutesAgo(15),
                    updatedAt: minutesAgo(15),
                },
            ]);

            await service.run!(makePayload({ origin: 'command' }));

            expect(
                codeReviewHandlerService.handlePullRequest,
            ).toHaveBeenCalled();
        });

        it('still blocks while the holder keeps heartbeating', async () => {
            withRows([
                {
                    uuid: 'live-execution',
                    status: 'in_progress',
                    createdAt: minutesAgo(15),
                    updatedAt: minutesAgo(0.5),
                },
            ]);

            const error = await service
                .run!(makePayload({ origin: 'command' }))
                .catch((raised) => raised);

            expect(isPrReviewInProgressError(error)).toBe(true);
            expect(error.gate).toBe('execution');
            expect(
                codeReviewHandlerService.handlePullRequest,
            ).not.toHaveBeenCalled();
        });
    });

    describe('while the review runs', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            automationExecutionService.touchInProgress = jest
                .fn()
                .mockResolvedValue(undefined);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('heartbeats its execution row and stops once it finishes', async () => {
            let finishReview!: (value: unknown) => void;
            codeReviewHandlerService.handlePullRequest.mockReturnValue(
                new Promise((resolve) => (finishReview = resolve)),
            );

            const run = service.run!(makePayload({ origin: 'command' }));
            await jest.advanceTimersByTimeAsync(0);
            expect(
                codeReviewHandlerService.handlePullRequest,
            ).toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(3 * 60_000);
            const beats =
                automationExecutionService.touchInProgress.mock.calls.length;
            expect(beats).toBeGreaterThanOrEqual(2);
            expect(
                automationExecutionService.touchInProgress,
            ).toHaveBeenCalledWith('execution-1');

            finishReview({ statusInfo: { status: 'success' } });
            await run;
            await jest.advanceTimersByTimeAsync(10 * 60_000);

            expect(
                automationExecutionService.touchInProgress,
            ).toHaveBeenCalledTimes(beats);
        });

        it('keeps reviewing when a heartbeat write fails', async () => {
            automationExecutionService.touchInProgress.mockRejectedValue(
                new Error('postgres blip'),
            );
            let finishReview!: (value: unknown) => void;
            codeReviewHandlerService.handlePullRequest.mockReturnValue(
                new Promise((resolve) => (finishReview = resolve)),
            );

            const run = service.run!(makePayload({ origin: 'command' }));
            await jest.advanceTimersByTimeAsync(2 * 60_000);
            finishReview({ statusInfo: { status: 'success' } });

            await expect(run).resolves.toBe(
                'Automation executed successfully',
            );
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

    // A commit pushed while the review ran was checked before the review
    // stored its suggestions, so they stayed not_implemented (#2182).
    describe('when the review finishes', () => {
        const reviewResult = (overrides: Record<string, unknown> = {}) => ({
            statusInfo: { status: 'success' },
            lastAnalyzedCommit: { sha: 'reviewed-sha' },
            ...overrides,
        });

        it.each([
            ['success', {}],
            ['partial_error', { errors: [{ severity: 'partial' }] }],
        ])(
            'checks implementation against the reviewed commit (%s)',
            async (_status, overrides) => {
                codeReviewHandlerService.handlePullRequest.mockResolvedValue(
                    reviewResult(overrides),
                );

                await service.run!(makePayload());

                expect(
                    enqueueImplementationCheckUseCase.execute,
                ).toHaveBeenCalledWith({
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    repository: { id: 'repo-1', name: 'repo-name' },
                    pullRequestNumber: 42,
                    commitSha: 'reviewed-sha',
                    trigger: 'review_completed',
                    platformType: 'github',
                });
            },
        );

        it('enqueues only after the execution is persisted', async () => {
            codeReviewHandlerService.handlePullRequest.mockResolvedValue(
                reviewResult(),
            );

            await service.run!(makePayload());

            const persistedAt =
                automationExecutionService.updateCodeReview.mock
                    .invocationCallOrder.at(-1);
            const enqueuedAt =
                enqueueImplementationCheckUseCase.execute.mock
                    .invocationCallOrder[0];
            expect(enqueuedAt).toBeGreaterThan(persistedAt!);
        });

        it.each([
            ['error', { errors: [{ severity: 'critical' }] }],
            ['skipped', { statusInfo: { status: 'skipped' } }],
            ['no reviewed commit', { lastAnalyzedCommit: undefined }],
        ])('does not check when %s', async (_case, overrides) => {
            codeReviewHandlerService.handlePullRequest.mockResolvedValue(
                reviewResult(overrides),
            );

            await service.run!(makePayload());

            expect(
                enqueueImplementationCheckUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        // Without a SUCCESS row the check would diff from an older review.
        it('does not check when the execution could not be persisted', async () => {
            codeReviewHandlerService.handlePullRequest.mockResolvedValue(
                reviewResult(),
            );
            automationExecutionService.updateCodeReview.mockRejectedValue(
                new Error('postgres unreachable'),
            );

            await service.run!(makePayload());

            expect(
                enqueueImplementationCheckUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it('a failed enqueue does not fail the review', async () => {
            codeReviewHandlerService.handlePullRequest.mockResolvedValue(
                reviewResult(),
            );
            enqueueImplementationCheckUseCase.execute.mockRejectedValue(
                new Error('queue down'),
            );

            await expect(service.run!(makePayload())).resolves.toBe(
                'Automation executed successfully',
            );
        });
    });
});
