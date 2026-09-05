import type { DataSource, EntityManager } from 'typeorm';
import type {
    IMessageBrokerService,
    MessagePayload,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import type { ObservabilityService } from '@libs/core/log/observability.service';
import type { IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import type { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';
import { WorkflowJobQueueService } from './workflow-job-queue.service';
import {
    CLI_REVIEW_EPHEMERAL_QUEUE_OPTIONS,
    CLI_REVIEW_EPHEMERAL_ROUTING_KEY,
} from './workflow-queue-arguments';

const job = {
    correlationId: 'correlation-1',
    workflowType: WorkflowType.CLI_CODE_REVIEW,
    handlerType: HandlerType.PIPELINE_ASYNC,
    payload: { input: { diff: 'diff' } },
    status: JobStatus.PENDING,
    priority: 0,
    retryCount: 0,
    maxRetries: 0,
} satisfies Omit<IWorkflowJob, 'id' | 'createdAt' | 'updatedAt'>;

const ephemeralPayload = {
    reviewContext: {
        source: 'cli-review-context-file' as const,
        contentType: 'text/plain; charset=utf-8' as const,
        body: 'CANARY: inspect cleanup',
    },
};

class TestMessageBroker implements IMessageBrokerService {
    readonly publishMessageMock: jest.MockedFunction<
        IMessageBrokerService['publishMessage']
    > = jest.fn().mockResolvedValue(undefined);

    isConnected(): boolean {
        return true;
    }

    publishMessage(
        ...parameters: Parameters<IMessageBrokerService['publishMessage']>
    ): Promise<void> {
        return this.publishMessageMock(...parameters);
    }

    transformMessageToMessageBroker<T>({
        eventName,
        message,
    }: {
        eventName: string;
        message: T;
        event_version?: number;
        occurred_on?: Date;
        messageId?: string;
    }): MessagePayload<T> {
        return {
            event_name: eventName,
            event_version: 1,
            occurred_on: new Date(0),
            payload: message,
            messageId: 'message-1',
        };
    }
}

function createHarness(): {
    service: WorkflowJobQueueService;
    messageBroker: TestMessageBroker;
    jobRepository: jest.Mocked<IWorkflowJobRepository>;
    outboxRepository: jest.Mocked<IOutboxMessageRepository>;
} {
    const messageBroker = new TestMessageBroker();
    const jobRepository = {
        create: jest.fn().mockResolvedValue({ uuid: 'job-1' }),
        update: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IWorkflowJobRepository>;
    const outboxRepository = {
        create: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IOutboxMessageRepository>;
    const transactionManager = {} as EntityManager;
    const dataSource = {
        transaction: jest.fn(
            async (callback: (manager: EntityManager) => Promise<unknown>) =>
                callback(transactionManager),
        ),
    } as unknown as DataSource;
    const observability = {
        runInSpan: jest.fn(
            async (
                _name: string,
                callback: (span: {
                    setAttributes: (attributes: object) => void;
                }) => Promise<string>,
            ) => callback({ setAttributes: () => undefined }),
        ),
    } as unknown as ObservabilityService;

    return {
        service: new WorkflowJobQueueService(
            messageBroker,
            jobRepository,
            outboxRepository,
            dataSource,
            observability,
        ),
        messageBroker,
        jobRepository,
        outboxRepository,
    };
}

describe('WorkflowJobQueueService ephemeral payloads', () => {
    it('uses a non-durable classic queue with no dead-letter route', () => {
        expect(CLI_REVIEW_EPHEMERAL_ROUTING_KEY).toBe(
            'workflow.ephemeral.CLI_CODE_REVIEW',
        );
        expect(CLI_REVIEW_EPHEMERAL_QUEUE_OPTIONS).toEqual({
            durable: false,
            autoDelete: false,
            arguments: {
                'x-queue-type': 'classic',
                'x-message-ttl': 2_100_000,
                'x-max-length': 100,
                'x-overflow': 'reject-publish',
            },
        });
    });

    it('publishes request context transiently without writing it to the job or outbox', async () => {
        const harness = createHarness();

        await expect(
            harness.service.enqueueEphemeral(job, ephemeralPayload),
        ).resolves.toBe('job-1');

        expect(harness.jobRepository.create).toHaveBeenCalledWith(
            job,
            expect.anything(),
        );
        expect(harness.outboxRepository.create).not.toHaveBeenCalled();
        expect(harness.messageBroker.publishMessageMock).toHaveBeenCalledWith(
            {
                exchange: 'workflow.exchange',
                routingKey: CLI_REVIEW_EPHEMERAL_ROUTING_KEY,
            },
            expect.objectContaining({
                payload: expect.objectContaining({
                    jobId: 'job-1',
                    ephemeralPayload,
                }),
            }),
            expect.objectContaining({
                persistent: false,
                expiration: expect.any(Number),
            }),
        );
        expect(
            JSON.stringify(harness.jobRepository.create.mock.calls),
        ).not.toContain(ephemeralPayload.reviewContext.body);
    });

    it('keeps ordinary jobs on the transactional outbox path', async () => {
        const harness = createHarness();

        await harness.service.enqueue(job);

        expect(harness.outboxRepository.create).toHaveBeenCalledTimes(1);
        expect(harness.messageBroker.publishMessageMock).not.toHaveBeenCalled();
    });

    it('marks the durable job failed when transient publish fails', async () => {
        const harness = createHarness();
        harness.messageBroker.publishMessageMock.mockRejectedValueOnce(
            new Error('broker unavailable'),
        );

        await expect(
            harness.service.enqueueEphemeral(job, ephemeralPayload),
        ).rejects.toThrow('broker unavailable');

        expect(harness.jobRepository.update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ status: JobStatus.FAILED }),
        );
    });
});
