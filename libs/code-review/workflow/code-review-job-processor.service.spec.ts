import { CodeReviewJobProcessorService } from './code-review-job-processor.service';
import { PrReviewInProgressError } from '@libs/code-review/domain/errors/pr-review-in-progress.error';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

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

        it('records the job as failed rather than completed', async () => {
            await service.process('job-1');

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.FAILED }),
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
            );
            expect(prReviewDeferralService.defer).not.toHaveBeenCalled();
        });
    });

    describe('on success', () => {
        it('completes the job', async () => {
            await service.process('job-1');

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
            );
        });
    });
});
