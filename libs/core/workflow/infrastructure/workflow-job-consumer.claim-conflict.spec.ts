import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import { InboxStatus } from './repositories/schemas/inbox-message.model';
import { WorkflowJobConsumer } from './workflow-job-consumer.service';
import { runSecurityScanSliceChild } from './security-scan-slice.runner';
import {
    SECURITY_SCAN_CLAIM_TIMEOUT_MINUTES,
    SECURITY_SCAN_JOB_QUEUE,
} from './security-scan-runtime';

jest.mock('./security-scan-slice.runner', () => ({
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
    };
    const observability = {
        setContext: jest.fn(),
        runInSpan: jest.fn(async (_name: string, fn: (span: any) => unknown) =>
            fn({ setAttributes: jest.fn() }),
        ),
    };
    const consumer = new WorkflowJobConsumer(
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
        const { consumer, jobRepository } = makeConsumer({
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

    it('claims a security-scan message with the short steal window', async () => {
        runChild.mockResolvedValue(undefined);
        const { consumer, inboxRepository } = makeConsumer();

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
        const { consumer, inboxRepository, jobRepository } = makeConsumer();

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
        const { consumer, inboxRepository, jobRepository } = makeConsumer({
            heartbeat: jest.fn().mockResolvedValue(false),
        });

        const done = (consumer as any).processWorkflowJob(
            'workflow-job-consumer.security_scan',
            SECURITY_SCAN_JOB_QUEUE,
            { jobId: 'job-1' },
            amqpMsg('msg-1'),
        );
        const assertion = expect(done).rejects.toBeInstanceOf(
            ClaimConflictError,
        );
        await jest.advanceTimersByTimeAsync(30_000);
        await assertion;

        expect(jobRepository.update).not.toHaveBeenCalled();
        expect(inboxRepository.releaseIfHeldBy).toHaveBeenCalled();
        expect(inboxRepository.completeIfHeldBy).not.toHaveBeenCalled();
    });
});
