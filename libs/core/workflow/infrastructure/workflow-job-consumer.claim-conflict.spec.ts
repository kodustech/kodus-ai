import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { InboxStatus } from './repositories/schemas/inbox-message.model';
import { WorkflowJobConsumer } from './workflow-job-consumer.service';
import { SecurityScanJobConsumer } from './security-scan-job.consumer';
import { runSecurityScanSliceChild } from './security-scan-slice.runner';
import {
    SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
    SECURITY_SCAN_HEARTBEAT_STALE_MS,
    SECURITY_SCAN_JOB_QUEUE,
    SECURITY_SCAN_SLICE_EXIT_PREEMPTED,
} from './security-scan-runtime';

jest.mock('./security-scan-slice.runner', () => ({
    ...jest.requireActual('./security-scan-slice.runner'),
    runSecurityScanSliceChild: jest.fn(),
}));

function amqpMsg(messageId: string) {
    return {
        properties: {
            messageId,
            correlationId: 'corr-1',
            headers: {},
        },
    };
}

function makeConsumer(overrides?: {
    claim?: jest.Mock;
    find?: jest.Mock;
    process?: jest.Mock;
    completeIfHeldBy?: jest.Mock;
    releaseIfHeldBy?: jest.Mock;
    heartbeat?: jest.Mock;
    updateJob?: jest.Mock;
    findJob?: jest.Mock;
    Consumer?: typeof WorkflowJobConsumer | typeof SecurityScanJobConsumer;
}) {
    const inboxRepository = {
        claim: overrides?.claim ?? jest.fn().mockResolvedValue({}),
        findByConsumerAndMessageId:
            overrides?.find ?? jest.fn().mockResolvedValue(null),
        completeIfHeldBy:
            overrides?.completeIfHeldBy ??
            jest.fn().mockResolvedValue(undefined),
        releaseIfHeldBy:
            overrides?.releaseIfHeldBy ??
            jest.fn().mockResolvedValue(undefined),
        heartbeat: overrides?.heartbeat ?? jest.fn().mockResolvedValue(true),
        releaseAllByInstance: jest.fn().mockResolvedValue(0),
    };
    const jobProcessor = {
        process: overrides?.process ?? jest.fn().mockResolvedValue(undefined),
    };
    const jobRepository = {
        update: overrides?.updateJob ?? jest.fn().mockResolvedValue(undefined),
        findOne:
            overrides?.findJob ??
            jest.fn().mockResolvedValue({ status: JobStatus.FAILED }),
    };
    const observability = {
        setContext: jest.fn(),
        runInSpan: jest.fn(async (_name: string, fn: (span: any) => unknown) =>
            fn({ setAttributes: jest.fn() }),
        ),
    };
    const Ctor = overrides?.Consumer ?? WorkflowJobConsumer;
    const consumer = new Ctor(
        jobProcessor as any,
        inboxRepository as any,
        jobRepository as any,
        observability as any,
        {
            protectTask: jest.fn().mockResolvedValue(undefined),
            unprotectTask: jest.fn().mockResolvedValue(undefined),
        } as any,
    );
    return { consumer, inboxRepository, jobProcessor, jobRepository };
}

function makeScanConsumer(
    overrides?: Omit<
        NonNullable<Parameters<typeof makeConsumer>[0]>,
        'Consumer'
    >,
) {
    return makeConsumer({ ...overrides, Consumer: SecurityScanJobConsumer });
}

const runChild = runSecurityScanSliceChild as jest.MockedFunction<
    typeof runSecurityScanSliceChild
>;

describe('WorkflowJobConsumer claim conflict and scan slices', () => {
    afterEach(() => {
        runChild.mockReset();
        jest.useRealTimers();
        jest.clearAllTimers();
    });

    it('throws ClaimConflictError without failing the job when the inbox is held', async () => {
        const { consumer, jobRepository } = makeScanConsumer({
            claim: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue({
                status: InboxStatus.PROCESSING,
            }),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toBeInstanceOf(ClaimConflictError);

        expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('acks a processed duplicate without throwing', async () => {
        const { consumer, jobProcessor } = makeConsumer({
            claim: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue({
                status: InboxStatus.PROCESSED,
            }),
        });

        await (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );

        expect(jobProcessor.process).not.toHaveBeenCalled();
    });

    it('retries a held code-review claim on the old path', async () => {
        const { consumer, jobRepository } = makeConsumer({
            claim: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue({
                status: InboxStatus.PROCESSING,
            }),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.code_review',
                'workflow.jobs.code_review.queue',
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toMatchObject({
            name: 'Error',
            message: 'Message already claimed but not finished',
        });

        expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('claims a security-scan message with the short steal window', async () => {
        runChild.mockResolvedValue(undefined);
        const { consumer, inboxRepository } = makeScanConsumer();

        await (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );

        expect(inboxRepository.claim).toHaveBeenCalledWith(
            'msg-1',
            'workflow-job-consumer.security_scan',
            expect.any(String),
            'job-1',
            SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
        );
        expect(runChild).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(inboxRepository.completeIfHeldBy).toHaveBeenCalled();
    });

    it('runs non-scan jobs in process', async () => {
        runChild.mockResolvedValue(undefined);
        const { consumer, jobProcessor } = makeConsumer();

        await (consumer as any).processWorkflowJob(
            'workflow-job-consumer.code_review',
            'workflow.jobs.code_review.queue',
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );

        expect(jobProcessor.process).toHaveBeenCalledWith('job-1');
        expect(runChild).not.toHaveBeenCalled();
    });

    it('releases the inbox only while this host still holds it', async () => {
        runChild.mockRejectedValue(new Error('child died'));
        const { consumer, inboxRepository, jobRepository } = makeScanConsumer();

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow('child died');

        expect(jobRepository.update).toHaveBeenCalled();
        expect(inboxRepository.releaseIfHeldBy).toHaveBeenCalled();
        expect(runChild).toHaveBeenCalled();
    });

    it('requeues an aborted slice without failing the job', async () => {
        jest.useFakeTimers();
        runChild.mockImplementation(
            (_jobId, options) =>
                new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener('abort', () => {
                        reject(new Error('exited SIGKILL'));
                    });
                }),
        );
        const { consumer, inboxRepository, jobRepository } = makeScanConsumer({
            heartbeat: jest.fn().mockResolvedValue(false),
        });

        const done = (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );
        const assertion =
            expect(done).rejects.toBeInstanceOf(ClaimConflictError);
        await jest.advanceTimersByTimeAsync(30_000);
        await assertion;

        expect(jobRepository.update).not.toHaveBeenCalled();
        expect(inboxRepository.releaseIfHeldBy).toHaveBeenCalled();
        expect(inboxRepository.completeIfHeldBy).not.toHaveBeenCalled();
    });

    it('does not overwrite the child job FAILED on a numeric exit', async () => {
        runChild.mockRejectedValue(
            new Error('Security scan slice child exited 1 for job job-1'),
        );
        const { consumer, jobRepository } = makeScanConsumer();

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow(/exited 1 for job/);

        expect(jobRepository.update).not.toHaveBeenCalled();
        expect(jobRepository.findOne).toHaveBeenCalledWith('job-1');
    });

    it('marks FAILED when the slice child exits 1 without recording', async () => {
        runChild.mockRejectedValue(
            new Error('Security scan slice child exited 1 for job job-1'),
        );
        const { consumer, jobRepository } = makeScanConsumer({
            findJob: jest
                .fn()
                .mockResolvedValue({ status: JobStatus.PROCESSING }),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow(/left job job-1 unrecorded/);

        expect(jobRepository.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ status: JobStatus.FAILED }),
        );
    });

    it('requeues a preempted child exit without failing the job', async () => {
        runChild.mockRejectedValue(
            new Error(
                `Security scan slice child exited ${SECURITY_SCAN_SLICE_EXIT_PREEMPTED} for job job-1`,
            ),
        );
        const { consumer, jobRepository } = makeScanConsumer({
            findJob: jest
                .fn()
                .mockResolvedValue({ status: JobStatus.PROCESSING }),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toBeInstanceOf(ClaimConflictError);

        expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('does not overwrite a terminal job when the child is SIGKILL-ed', async () => {
        runChild.mockRejectedValue(
            new Error('Security scan slice child exited SIGKILL for job job-1'),
        );
        const { consumer, jobRepository } = makeScanConsumer();

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow(/exited SIGKILL for job/);

        expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('marks FAILED when SIGKILL leaves the job unrecorded', async () => {
        runChild.mockRejectedValue(
            new Error('Security scan slice child exited SIGKILL for job job-1'),
        );
        const { consumer, jobRepository } = makeScanConsumer({
            findJob: jest
                .fn()
                .mockResolvedValue({ status: JobStatus.PROCESSING }),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow(/left job job-1 unrecorded/);

        expect(jobRepository.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ status: JobStatus.FAILED }),
        );
    });

    it('marks FAILED when the job lookup fails after a child exit', async () => {
        runChild.mockRejectedValue(
            new Error('Security scan slice child exited 1 for job job-1'),
        );
        const { consumer, jobRepository } = makeScanConsumer({
            findJob: jest
                .fn()
                .mockRejectedValue(new Error('bounded timeout after 10000ms')),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toThrow(/status unknown after slice child exit/);

        expect(jobRepository.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ status: JobStatus.FAILED }),
        );
    });

    it('requeues a preempted child when the job lookup fails', async () => {
        runChild.mockRejectedValue(
            new Error(
                `Security scan slice child exited ${SECURITY_SCAN_SLICE_EXIT_PREEMPTED} for job job-1`,
            ),
        );
        const { consumer, jobRepository } = makeScanConsumer({
            findJob: jest
                .fn()
                .mockRejectedValue(new Error('bounded timeout after 10000ms')),
        });

        await expect(
            (consumer as any).processWorkflowJob(
                'workflow-job-consumer.security_scan',
                SECURITY_SCAN_JOB_QUEUE,
                { jobId: 'job-1' },
                amqpMsg('msg-1'),
            ),
        ).rejects.toBeInstanceOf(ClaimConflictError);

        expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('does not abort a slice on a single heartbeat error', async () => {
        jest.useFakeTimers();
        let aborted = false;
        runChild.mockImplementation(
            (_jobId, options) =>
                new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener('abort', () => {
                        aborted = true;
                        reject(new Error('exited SIGKILL'));
                    });
                }),
        );
        const { consumer } = makeScanConsumer({
            heartbeat: jest.fn().mockRejectedValue(new Error('pg blip')),
        });

        const done = (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );
        done.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(aborted).toBe(false);

        const assertion =
            expect(done).rejects.toBeInstanceOf(ClaimConflictError);
        await jest.advanceTimersByTimeAsync(SECURITY_SCAN_HEARTBEAT_STALE_MS);
        await assertion;
        expect(aborted).toBe(true);
    });

    it('does not stack overlapping heartbeats', async () => {
        jest.useFakeTimers();
        const heartbeat = jest
            .fn()
            .mockImplementation(() => new Promise(() => undefined));
        runChild.mockImplementation(() => new Promise(() => undefined));
        const { consumer } = makeScanConsumer({ heartbeat });

        void (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );
        await jest.advanceTimersByTimeAsync(30_000);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(heartbeat).toHaveBeenCalledTimes(1);
    });

    it('aborts a slice when a hung heartbeat goes stale', async () => {
        jest.useFakeTimers();
        let aborted = false;
        runChild.mockImplementation(
            (_jobId, options) =>
                new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener('abort', () => {
                        aborted = true;
                        reject(new Error('exited SIGKILL'));
                    });
                }),
        );
        const { consumer } = makeScanConsumer({
            heartbeat: jest
                .fn()
                .mockImplementation(() => new Promise(() => undefined)),
        });

        const done = (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );
        done.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(aborted).toBe(false);

        const assertion =
            expect(done).rejects.toBeInstanceOf(ClaimConflictError);
        await jest.advanceTimersByTimeAsync(SECURITY_SCAN_HEARTBEAT_STALE_MS);
        await assertion;
        expect(aborted).toBe(true);
    });
});
