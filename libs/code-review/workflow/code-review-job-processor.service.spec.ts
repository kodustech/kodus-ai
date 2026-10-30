import { CodeReviewJobProcessorService } from './code-review-job-processor.service';
import { PrReviewInProgressError } from '@libs/code-review/domain/errors/pr-review-in-progress.error';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { JobAbortedError } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

const TARGET = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'repo-name' },
    pullRequest: { number: 42 },
    platformType: 'github' as any,
    triggerCommentId: 7,
};

const makeJob = (overrides: Partial<any> = {}): any => ({
    id: 'job-1',
    correlationId: 'corr-1',
    workflowType: 'code_review',
    handlerType: 'pipeline_sync',
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    metadata: {},
    payload: {
        codeManagementPayload: { origin: 'command' },
        event: 'issue_comment',
        platformType: 'github',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        teamAutomationId: 'team-automation-1',
    },
    ...overrides,
});

describe('CodeReviewJobProcessorService', () => {
    let service: CodeReviewJobProcessorService;
    let jobRepository: Record<string, jest.Mock>;
    let runCodeReviewAutomationUseCase: { execute: jest.Mock };
    let byokConcurrencyGateService: Record<string, jest.Mock>;
    let notificationService: { emit: jest.Mock };
    let prAuthorRecipientResolver: { resolve: jest.Mock };
    let rateLimitGate: { check: jest.Mock };
    let prReviewDeferralService: Record<string, jest.Mock>;
    let codeReviewHandlerService: Record<string, jest.Mock>;

    beforeEach(() => {
        jobRepository = {
            findOne: jest.fn().mockResolvedValue(makeJob()),
            update: jest.fn().mockResolvedValue(undefined),
        };
        runCodeReviewAutomationUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        byokConcurrencyGateService = {
            tryEnter: jest.fn().mockResolvedValue({ kind: 'unlimited' }),
            deferJob: jest.fn(),
        };
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        prAuthorRecipientResolver = {
            resolve: jest.fn().mockResolvedValue(null),
        };
        rateLimitGate = { check: jest.fn().mockResolvedValue(undefined) };
        prReviewDeferralService = {
            next: jest.fn().mockReturnValue({ deferredCount: 1, delayMs: 15000 }),
            defer: jest.fn().mockResolvedValue(undefined),
        };
        codeReviewHandlerService = {
            notifyCommandReviewRefused: jest.fn().mockResolvedValue(undefined),
        };

        service = new CodeReviewJobProcessorService(
            jobRepository as any,
            runCodeReviewAutomationUseCase as any,
            byokConcurrencyGateService as any,
            notificationService as any,
            prAuthorRecipientResolver as any,
            rateLimitGate as any,
            prReviewDeferralService as any,
            codeReviewHandlerService as any,
        );
    });

    const refuse = (gate: 'lock' | 'execution' = 'lock') =>
        runCodeReviewAutomationUseCase.execute.mockRejectedValue(
            new PrReviewInProgressError({ gate, target: TARGET }),
        );

    // The refused request used to land as a COMPLETED job with no error and
    // no retry, which is why nothing ever surfaced it (#1700).
    describe('when the PR is busy and retries remain', () => {
        beforeEach(refuse);

        it('reschedules quietly: not failed, not completed, not raised, nobody notified', async () => {
            await expect(service.process('job-1')).resolves.toBeUndefined();

            expect(prReviewDeferralService.defer).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'job-1' }),
                { deferredCount: 1, delayMs: 15000 },
            );
            expect(jobRepository.update).not.toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
            expect(jobRepository.update).not.toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
            );
            expect(
                codeReviewHandlerService.notifyCommandReviewRefused,
            ).not.toHaveBeenCalled();
            expect(notificationService.emit).not.toHaveBeenCalled();
        });
    });

    describe('when the PR stayed busy for the whole retry window', () => {
        beforeEach(() => {
            refuse();
            prReviewDeferralService.next.mockReturnValue(null);
        });

        it('tells the user on the PR and records the job as failed, without rescheduling', async () => {
            await service.process('job-1');

            expect(
                codeReviewHandlerService.notifyCommandReviewRefused,
            ).toHaveBeenCalledWith(TARGET);
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
            expect(prReviewDeferralService.defer).not.toHaveBeenCalled();
        });

        it('still settles even if the PR comment cannot be posted', async () => {
            codeReviewHandlerService.notifyCommandReviewRefused.mockRejectedValue(
                new Error('provider unreachable'),
            );

            await expect(service.process('job-1')).resolves.toBeUndefined();
        });
    });

    describe('for any other failure', () => {
        it('keeps failing the job and raising', async () => {
            runCodeReviewAutomationUseCase.execute.mockRejectedValue(
                new Error('pipeline exploded'),
            );

            await expect(service.process('job-1')).rejects.toThrow(
                'pipeline exploded',
            );
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
            expect(prReviewDeferralService.defer).not.toHaveBeenCalled();
        });
    });

    describe('on success', () => {
        it('checks the rate-limit gate for the job, runs the review and completes the job', async () => {
            await service.process('job-1');

            expect(rateLimitGate.check).toHaveBeenCalledWith(
                { organizationId: 'org-1', teamId: 'team-1' },
                'github',
            );
            expect(runCodeReviewAutomationUseCase.execute).toHaveBeenCalled();
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
            );
        });
    });

    // A GitHub bucket below the safety threshold must stop the job before it
    // takes a BYOK slot or spends LLM tokens, and the error must carry resetAt
    // so the consumer can delay the retry to the bucket reset.
    describe('when the rate-limit gate refuses', () => {
        it('raises the RateLimitError with its resetAt before admission or the use case', async () => {
            const resetAt = new Date(Date.now() + 47 * 60 * 1000);
            rateLimitGate.check.mockRejectedValue(
                new RateLimitError({ resetAt, remaining: 12 }),
            );

            const error = await service.process('job-1').catch((e) => e);

            expect(error).toBeInstanceOf(RateLimitError);
            expect((error as RateLimitError).resetAt).toEqual(resetAt);
            expect(byokConcurrencyGateService.tryEnter).not.toHaveBeenCalled();
            expect(runCodeReviewAutomationUseCase.execute).not.toHaveBeenCalled();
        });
    });

    // The use case receives the signal, but a link that ignores it (an
    // octokit retry-after sleep) kept the processor pending past the router
    // timeout and leaked the worker slot.
    describe('AbortSignal', () => {
        it('unblocks when the signal fires while the use case is stuck', async () => {
            runCodeReviewAutomationUseCase.execute.mockImplementation(
                () => new Promise(() => {}),
            );
            const controller = new AbortController();
            const work = service.process('job-1', controller.signal);

            await new Promise((r) => setTimeout(r, 20));
            expect(runCodeReviewAutomationUseCase.execute).toHaveBeenCalledTimes(1);

            controller.abort();

            await expect(work).rejects.toBeInstanceOf(JobAbortedError);
        });

        it('does not start when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                service.process('job-1', controller.signal),
            ).rejects.toThrow(/aborted before start/);
            expect(runCodeReviewAutomationUseCase.execute).not.toHaveBeenCalled();
        });
    });

    /**
     * Tell the author once, and do not stop telling them because of a crash.
     *
     * `process()` does not check job status on entry, so a redelivery — a
     * broker retry, or the stale-job reaper picking the row back up — runs the
     * exhausted branch again, and a repeat notice reaches a customer. Gating
     * that on `status === FAILED` was a trap: `handleFailure` writes that
     * status whether or not anyone was told, so a crash between the two would
     * silence the notice forever. The marker records the NOTIFICATION.
     */
    describe('when no BYOK slot ever came free', () => {
        beforeEach(() => {
            byokConcurrencyGateService.tryEnter.mockResolvedValue({
                kind: 'exhausted',
                deferredCount: 452,
            });
        });

        it('fails the job, tells the author and records that it did', async () => {
            jobRepository.findOne.mockResolvedValue(
                makeJob({ metadata: { existing: true } }),
            );

            await service.process('job-1');

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
            expect(notificationService.emit).toHaveBeenCalledTimes(1);

            const marker = jobRepository.update.mock.calls.at(-1)?.[1];
            expect(marker.metadata.byokSlotExhausted.notifiedAt).toEqual(
                expect.any(String),
            );
            // 452 against a cap of 10 is what made this branch necessary;
            // losing the number would lose the reason it exists.
            expect(marker.metadata.byokSlotExhausted.deferredCount).toBe(452);
            expect(marker.metadata.existing).toBe(true);
        });

        it('does not tell the author twice on a redelivery', async () => {
            jobRepository.findOne.mockResolvedValue(
                makeJob({
                    status: 'failed',
                    metadata: {
                        byokSlotExhausted: {
                            notifiedAt: '2026-09-03T12:00:00.000Z',
                        },
                    },
                }),
            );

            await service.process('job-1');

            expect(notificationService.emit).not.toHaveBeenCalled();
        });

        it('still tells the author when the job is FAILED but was never notified', async () => {
            // The crash window: handleFailure wrote the status, then the
            // worker died. Gating on status would have silenced this forever.
            jobRepository.findOne.mockResolvedValue(
                makeJob({ status: 'failed', metadata: {} }),
            );

            await service.process('job-1');

            expect(notificationService.emit).toHaveBeenCalledTimes(1);
        });
    });

    // The platform-payload extraction + recipient composition of the
    // review.failed notification.
    describe('review.failed emit', () => {
        const callNotify = (
            payload: unknown,
            error: Error = new Error('terminal failure'),
            correlationId = 'corr-1',
        ) =>
            (service as any).notifyReviewFailed(
                { payload },
                error,
                correlationId,
            );

        it('emits with the PR author as the only directed recipient (owners are the config audience)', async () => {
            prAuthorRecipientResolver.resolve.mockResolvedValueOnce({
                kind: 'user',
                userId: 'user-1',
            });

            await callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {
                    pull_request: {
                        html_url: 'https://github.com/acme/api/pull/1',
                        user: { email: 'alex@a.com', login: 'alex' },
                    },
                    repository: { full_name: 'acme/api' },
                },
            });

            expect(notificationService.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: NotificationEvent.REVIEW_FAILED,
                    organizationId: 'org-1',
                    correlationId: 'corr-1',
                    recipients: [{ kind: 'user', userId: 'user-1' }],
                    payload: expect.objectContaining({
                        prUrl: 'https://github.com/acme/api/pull/1',
                        repoName: 'acme/api',
                        reason: 'terminal failure',
                        correlationId: 'corr-1',
                    }),
                }),
            );
        });

        it('emits with no directed recipients when the PR author cannot be resolved (owners via audience)', async () => {
            await callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {
                    pull_request: {
                        html_url: 'https://github.com/acme/api/pull/1',
                        user: {
                            email: 'dependabot@github.com',
                            login: 'dependabot[bot]',
                        },
                    },
                    repository: { full_name: 'acme/api' },
                },
            });

            expect(notificationService.emit.mock.calls[0][0].recipients).toEqual(
                [],
            );
        });

        it('skips when organizationId is missing from the job payload', async () => {
            await callNotify({});
            expect(notificationService.emit).not.toHaveBeenCalled();
        });

        it('extracts GitLab merge_request shape', async () => {
            await callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {
                    object_attributes: {
                        web_url: 'https://gitlab.com/acme/api/-/merge_requests/3',
                    },
                    repository: { name: 'acme/api' },
                },
            });

            expect(notificationService.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    payload: expect.objectContaining({
                        prUrl: 'https://gitlab.com/acme/api/-/merge_requests/3',
                        repoName: 'acme/api',
                    }),
                }),
            );
        });

        it('extracts Bitbucket pullrequest shape', async () => {
            await callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {
                    pullrequest: {
                        url: 'https://bitbucket.org/acme/api/pull-requests/9',
                    },
                    repository: { full_name: 'acme/api' },
                },
            });

            expect(notificationService.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    payload: expect.objectContaining({
                        prUrl: 'https://bitbucket.org/acme/api/pull-requests/9',
                    }),
                }),
            );
        });

        it('falls back to empty strings when payload fields are absent (still notifies owners)', async () => {
            await callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {},
            });

            expect(notificationService.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    payload: expect.objectContaining({
                        prUrl: '',
                        repoName: '',
                        reason: 'terminal failure',
                    }),
                }),
            );
        });

        it('does not throw when notificationService.emit itself fails', async () => {
            notificationService.emit.mockRejectedValueOnce(
                new Error('outbox down'),
            );

            await expect(
                callNotify({
                    organizationAndTeamData: { organizationId: 'org-1' },
                    codeManagementPayload: {},
                }),
            ).resolves.toBeUndefined();
        });
    });
});
