import { CodeReviewJobProcessorService } from './code-review-job-processor.service';
import { PrReviewInProgressError } from '@libs/code-review/domain/errors/pr-review-in-progress.error';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { JOB_LEASE_RENEW_INTERVAL_MS } from '@libs/core/workflow/infrastructure/job-lease.renewer';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

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

        it('reschedules the request', async () => {
            await service.process('job-1');

            expect(prReviewDeferralService.defer).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'job-1' }),
                { deferredCount: 1, delayMs: 15000 },
            );
        });

        it('does not mark the job failed', async () => {
            await service.process('job-1');

            expect(jobRepository.update).not.toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
        });

        it('does not mark the job completed', async () => {
            await service.process('job-1');

            expect(jobRepository.update).not.toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
            );
        });

        it('does not raise, so the message is not retried by the broker', async () => {
            await expect(service.process('job-1')).resolves.toBeUndefined();
        });

        it('stays quiet on the PR while the request is still queued', async () => {
            await service.process('job-1');

            expect(
                codeReviewHandlerService.notifyCommandReviewRefused,
            ).not.toHaveBeenCalled();
        });

        it('does not email the author about a failure', async () => {
            await service.process('job-1');

            expect(notificationService.emit).not.toHaveBeenCalled();
        });
    });

    describe('when the PR stayed busy for the whole retry window', () => {
        beforeEach(() => {
            refuse();
            prReviewDeferralService.next.mockReturnValue(null);
        });

        it('tells the user on the PR', async () => {
            await service.process('job-1');

            expect(
                codeReviewHandlerService.notifyCommandReviewRefused,
            ).toHaveBeenCalledWith(TARGET);
        });

        it('stays quiet when the lease was reclaimed while giving up', async () => {
            // The guarded failure write matched no row: the reaper requeued the
            // job and another worker owns it now, so that worker will re-drive
            // the review. Telling the author it was dropped would contradict
            // what actually happens, and the drop would be recorded on a row
            // this run no longer owns.
            jobRepository.update.mockImplementation((_id: string, data: any) =>
                data?.status === JobStatus.FAILED
                    ? Promise.resolve(false)
                    : Promise.resolve(undefined),
            );

            await service.process('job-1');

            expect(
                codeReviewHandlerService.notifyCommandReviewRefused,
            ).not.toHaveBeenCalled();
        });

        it('records the job as failed rather than completed', async () => {
            await service.process('job-1');

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
                // The abandon path runs inside the leased run, so the same
                // ownership fence applies as everywhere else.
                { leaseOwner: expect.any(String) },
            );
        });

        it('does not reschedule again', async () => {
            await service.process('job-1');

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
                // The failure path reached from a run that still holds the lease
                // carries the same ownership guard as completion.
                { leaseOwner: expect.any(String) },
            );
            expect(prReviewDeferralService.defer).not.toHaveBeenCalled();
        });
    });

    describe('handleFailure ownership (#1830 review)', () => {
        it('leaves the row to the worker that took it over, and says so', async () => {
            const warn = jest
                .spyOn((service as unknown as { logger: any }).logger, 'warn')
                .mockImplementation(() => undefined);
            // The guarded write matched no row: the reaper already requeued
            // this job and another worker owns it now.
            jobRepository.update.mockResolvedValueOnce(false);

            const landed = await service.handleFailure('job-1', new Error('boom'), {
                ownedBy: 'instance-1',
                organizationId: 'org-1',
            });

            // The caller needs this answer. Told nothing, it went on to notify
            // the author and rethrow, and the catches above stamped
            // FAILED/PERMANENT unguarded over the row the new worker is running.
            expect(landed).toBe(false);
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
                { leaseOwner: 'instance-1' },
            );
            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('no longer owned'),
                    metadata: expect.objectContaining({
                        jobId: 'job-1',
                        instanceId: 'instance-1',
                        organizationId: 'org-1',
                    }),
                }),
            );
            warn.mockRestore();
        });

        it('reports the failure as landed when the guarded write matched', async () => {
            jobRepository.update.mockResolvedValueOnce(true);

            await expect(
                service.handleFailure('job-1', new Error('boom'), {
                    ownedBy: 'instance-1',
                }),
            ).resolves.toBe(true);
        });

        it('still writes the failure unguarded on the exhausted-retry path', async () => {
            // No worker owns the row by then, and this status is what stops the
            // job being redelivered forever.
            const landed = await service.handleFailure(
                'job-1',
                new Error('boom'),
            );

            expect(landed).toBe(true);
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
            );
        });

        it('fences the no-lease failure write on "nobody live owns it"', async () => {
            // The caller holds no lease, so there is none to match — but that is
            // not the same as nobody running the job: a redelivery of the same
            // jobId can reach that branch while another worker holds the row.
            jobRepository.update.mockResolvedValueOnce(true);

            await expect(
                service.handleFailure('job-1', new Error('boom'), {
                    organizationId: 'org-1',
                    requireNoLiveOwner: true,
                }),
            ).resolves.toBe(true);

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
                { noLiveOwner: true },
            );
        });

        it('reports a live owner instead of stamping FAILED over its row', async () => {
            const warn = jest
                .spyOn((service as unknown as { logger: any }).logger, 'warn')
                .mockImplementation(() => undefined);
            jobRepository.update.mockResolvedValueOnce(false);

            await expect(
                service.handleFailure('job-1', new Error('boom'), {
                    organizationId: 'org-1',
                    requireNoLiveOwner: true,
                }),
            ).resolves.toBe(false);

            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'live worker owns the row',
                    ),
                    metadata: expect.objectContaining({
                        jobId: 'job-1',
                        organizationId: 'org-1',
                    }),
                }),
            );
            warn.mockRestore();
        });
    });

    describe('a failure raised before the lease was claimed', () => {
        it('fails loudly and lets the message be republished instead of vanishing', async () => {
            // The rate-limit gate throws BEFORE the PROCESSING/leaseOwner write,
            // so the ownership guard has no lease to match. Reading its miss as
            // "another worker owns this" returned early: the consumer acked the
            // message, the job vanished with no FAILED stamp, no republish and no
            // notice, and the row stayed PENDING where neither
            // findStaleProcessing nor requeueStaleJobs ever selects it.
            rateLimitGate.check.mockRejectedValue(
                new RateLimitError({ resetAt: new Date() }),
            );

            await expect(service.process('job-1')).rejects.toThrow(
                /rate limit/i,
            );

            const failureCall = jobRepository.update.mock.calls.find(
                ([, data]) => data?.status === JobStatus.FAILED,
            );
            expect(failureCall).toBeDefined();
            // Nothing was claimed, so the write is not fenced on a lease.
            expect(failureCall).toHaveLength(2);
        });

        it('stops quietly when the lease it held was reclaimed', async () => {
            // The mirror case: this run DID claim the lease, and the guarded
            // failure write matched no row, so the reaper already requeued the
            // job for another worker. There is nothing left to record or notify
            // on this run, and rethrowing would stamp FAILED over the row that
            // worker is running.
            runCodeReviewAutomationUseCase.execute.mockRejectedValue(
                new Error('pipeline exploded'),
            );
            jobRepository.update.mockImplementation((_id: string, data: any) =>
                data?.status === JobStatus.FAILED
                    ? Promise.resolve(false)
                    : Promise.resolve(undefined),
            );

            await expect(service.process('job-1')).resolves.toBeUndefined();
            expect(notificationService.emit).not.toHaveBeenCalled();
        });
    });

    describe('on success', () => {
        it('completes the job', async () => {
            await service.process('job-1');

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
                // Terminal transition carries the ownership guard: only the
                // worker still holding the lease may complete the job.
                { leaseOwner: expect.any(String) },
            );
        });

        it('leaves the row alone when the lease was reclaimed mid-run', async () => {
            // The guarded write matched no row (reaper requeued it, another
            // worker owns it now), so the completion must not flip the row to
            // COMPLETED behind that worker's back and swallow its retry.
            jobRepository.update.mockImplementation(
                (_id: string, data: any) =>
                    data && data.status === JobStatus.COMPLETED
                        ? Promise.resolve(false)
                        : Promise.resolve(undefined),
            );

            await expect(service.process('job-1')).resolves.toBeUndefined();

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
                { leaseOwner: expect.any(String) },
            );
        });
    });

    describe('when the job lease is lost (repeated renewal failures)', () => {
        it('aborts the run so the reaper cannot reclaim a live job twice', async () => {
            jest.useFakeTimers();
            try {
                // State writes (PROCESSING / FAILED / COMPLETED carry a
                // `status`) succeed; only the lease-renewal writes fail.
                jobRepository.update.mockImplementation(
                    (_id: string, data: any) =>
                        data && data.status === undefined
                            ? Promise.reject(new Error('db down'))
                            : Promise.resolve(undefined),
                );
                runCodeReviewAutomationUseCase.execute.mockImplementation(
                    () => new Promise(() => {}), // never settles
                );

                const run = service.process('job-1');
                // Attach the resolve handler BEFORE the timers fire so the
                // lease-lost unblock is never momentarily unhandled.
                const assertion = expect(run).resolves.toBeUndefined();

                // Two consecutive renewal failures (30s cadence) → lease lost.
                await jest.advanceTimersByTimeAsync(
                    JOB_LEASE_RENEW_INTERVAL_MS * 3,
                );

                // The run must unblock instead of executing a job the reaper
                // may already own, and RESOLVE (not throw): throwing would let
                // the router/consumer catch write FAILED/PERMANENT, and the
                // lease reaper only reclaims PROCESSING rows.
                await assertion;

                // A lease-lost abort is a reclaimable, not a terminal,
                // outcome: the reaper requeues the job once the lease
                // expires, so we must NOT write FAILED/PERMANENT nor tell
                // the author — otherwise a transient renewal blip becomes
                // the permanent failure #1830 removes (#1830 review).
                const statusUpdates = jobRepository.update.mock.calls.filter(
                    ([, data]: [string, any]) => data?.status !== undefined,
                );
                expect(
                    statusUpdates.some(
                        ([, data]: [string, any]) =>
                            data.status === JobStatus.FAILED,
                    ),
                ).toBe(false);
                const notifySpy = jest.spyOn(
                    service as any,
                    'notifyReviewFailed',
                );
                expect(notifySpy).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
