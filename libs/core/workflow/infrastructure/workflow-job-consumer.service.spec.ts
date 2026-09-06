import type { ConsumeMessage } from 'amqplib';
import type { IJobProcessorService } from '../domain/contracts/job-processor.service.contract';
import type { IInboxMessageRepository } from '../domain/contracts/inbox-message.repository.contract';
import type { ITaskProtectionService } from '../domain/contracts/task-protection.service.contract';
import type { IWorkflowJobRepository } from '../domain/contracts/workflow-job.repository.contract';
import type { ObservabilityService } from '@libs/core/log/observability.service';
import { ErrorClassification } from '../domain/enums/error-classification.enum';
import { JobStatus } from '../domain/enums/job-status.enum';
import { EPHEMERAL_JOB_TERMINAL_MESSAGE } from './ephemeral-job-lifecycle';
import {
    EphemeralJobReconciliationError,
    WorkflowJobConsumer,
} from './workflow-job-consumer.service';
import { runWithBoundedTimeout } from './run-with-bounded-timeout';

describe('runWithBoundedTimeout (consumer cleanup bound)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('resolves with the operation result when it completes in time', async () => {
        const result = await runWithBoundedTimeout(
            Promise.resolve('ok'),
            100,
            'op',
        );
        expect(result).toBe('ok');
    });

    it('rejects with a labeled timeout when the operation exceeds the budget', async () => {
        jest.useFakeTimers();
        const hung = new Promise(() => {}); // never settles

        const p = runWithBoundedTimeout(hung, 10_000, 'inbox.releaseLock');
        // Suppress unhandled rejection before we await
        p.catch(() => {});

        await jest.advanceTimersByTimeAsync(10_000 + 1);

        await expect(p).rejects.toThrow(
            'inbox.releaseLock bounded timeout after 10000ms',
        );
    });

    it('propagates the underlying rejection when the op fails fast', async () => {
        const failing = Promise.reject(new Error('mongo: ECONNRESET'));

        await expect(
            runWithBoundedTimeout(failing, 10_000, 'op'),
        ).rejects.toThrow('mongo: ECONNRESET');
    });

    it('clears the timer when the op resolves (no orphan handles)', async () => {
        const clearSpy = jest.spyOn(global, 'clearTimeout');

        await runWithBoundedTimeout(Promise.resolve('ok'), 10_000, 'op');

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    it('clears the timer when the op rejects (no orphan handles)', async () => {
        const clearSpy = jest.spyOn(global, 'clearTimeout');

        await expect(
            runWithBoundedTimeout(
                Promise.reject(new Error('boom')),
                10_000,
                'op',
            ),
        ).rejects.toThrow('boom');

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });
});

describe('WorkflowJobConsumer ephemeral terminal reconciliation', () => {
    function harness(options?: {
        reconciliationError?: Error;
        reconciliationResult?: boolean;
        durableStatus?: JobStatus | null;
    }) {
        const jobProcessor = {
            process: jest.fn(),
        } as unknown as IJobProcessorService;
        const inboxRepository = {
            claim: jest.fn().mockResolvedValue(false),
            findByConsumerAndMessageId: jest.fn().mockResolvedValue({
                status: 'PROCESSING',
            }),
        } as unknown as jest.Mocked<IInboxMessageRepository>;
        const jobRepository = {
            failEphemeralJob: options?.reconciliationError
                ? jest.fn().mockRejectedValue(options.reconciliationError)
                : jest
                      .fn()
                      .mockResolvedValue(options?.reconciliationResult ?? true),
            findOne: jest.fn().mockResolvedValue(
                options?.durableStatus === null
                    ? null
                    : {
                          status: options?.durableStatus ?? JobStatus.PENDING,
                      },
            ),
        } as unknown as jest.Mocked<IWorkflowJobRepository>;
        const observability = {
            setContext: jest.fn(),
            runInSpan: jest.fn(),
        } as unknown as ObservabilityService;
        const taskProtection = {
            protectTask: jest.fn().mockResolvedValue(undefined),
            unprotectTask: jest.fn().mockResolvedValue(undefined),
        } as unknown as ITaskProtectionService;
        const consumer = new WorkflowJobConsumer(
            jobProcessor,
            inboxRepository,
            jobRepository,
            observability,
            taskProtection,
        );
        const message = {
            jobId: 'job-ephemeral-1',
            correlationId: 'correlation-1',
            ephemeralPayload: { reviewContext: { body: 'CANARY private' } },
        };
        const amqpMessage = {
            properties: {
                messageId: 'message-1',
                correlationId: 'correlation-1',
                headers: { 'x-kodus-ephemeral': true },
            },
            fields: {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.ephemeral.CLI_CODE_REVIEW',
            },
            content: Buffer.from('ephemeral'),
        } as unknown as ConsumeMessage;

        return { consumer, jobProcessor, jobRepository, message, amqpMessage };
    }

    it('marks a claim-race drop terminal before the message can be acknowledged', async () => {
        const test = harness();

        await expect(
            test.consumer.handleEphemeralCliCodeReviewJob(
                test.message,
                test.amqpMessage,
            ),
        ).rejects.toThrow('already claimed');

        expect(test.jobRepository.failEphemeralJob).toHaveBeenCalledWith(
            'job-ephemeral-1',
            {
                lastError: EPHEMERAL_JOB_TERMINAL_MESSAGE,
                errorClassification: ErrorClassification.PERMANENT,
            },
        );
        expect(test.jobProcessor.process).not.toHaveBeenCalled();
        expect(
            JSON.stringify(test.jobRepository.failEphemeralJob.mock.calls),
        ).not.toContain('CANARY private');
    });

    it.each([JobStatus.PENDING, JobStatus.PROCESSING])(
        'keeps the message recoverable when reconciliation leaves the job %s',
        async (durableStatus) => {
            const test = harness({
                reconciliationResult: false,
                durableStatus,
            });

            await expect(
                test.consumer.handleEphemeralCliCodeReviewJob(
                    test.message,
                    test.amqpMessage,
                ),
            ).rejects.toBeInstanceOf(EphemeralJobReconciliationError);

            expect(test.jobRepository.findOne).toHaveBeenCalledWith(
                'job-ephemeral-1',
            );
        },
    );

    it.each([JobStatus.FAILED, JobStatus.COMPLETED, null])(
        'does not claim reconciliation failed when the durable job is already terminal or absent (%s)',
        async (durableStatus) => {
            const test = harness({
                reconciliationResult: false,
                durableStatus,
            });

            await expect(
                test.consumer.handleEphemeralCliCodeReviewJob(
                    test.message,
                    test.amqpMessage,
                ),
            ).rejects.toThrow('already claimed');
        },
    );

    it('signals that the message must remain recoverable when terminal reconciliation fails', async () => {
        const test = harness({
            reconciliationError: new Error('db unavailable'),
        });

        await expect(
            test.consumer.handleEphemeralCliCodeReviewJob(
                test.message,
                test.amqpMessage,
            ),
        ).rejects.toBeInstanceOf(EphemeralJobReconciliationError);
    });
});
