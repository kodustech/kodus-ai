import { MessageBrokerService } from './messageBroker.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('MessageBrokerService', () => {
    const makeService = () => {
        const amqpConnection = {
            connected: true,
            publish: jest.fn().mockResolvedValue(undefined),
        };

        return {
            service: new MessageBrokerService(amqpConnection as any),
            amqpConnection,
        };
    };

    it('uses the envelope messageId as the AMQP messageId by default', async () => {
        const { service, amqpConnection } = makeService();
        const message = {
            event_name: 'workflow.jobs.created',
            event_version: 1,
            occurred_on: new Date('2026-04-24T12:00:00.000Z'),
            payload: { jobId: 'job-1' },
            messageId: 'message-1',
        };

        await service.publishMessage(
            {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.jobs.created.CODE_REVIEW',
            },
            message,
        );

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange',
            'workflow.jobs.created.CODE_REVIEW',
            message,
            expect.objectContaining({
                persistent: true,
                messageId: 'message-1',
            }),
        );
    });

    it('keeps an explicit AMQP messageId override when provided', async () => {
        const { service, amqpConnection } = makeService();
        const message = {
            event_name: 'workflow.jobs.created',
            event_version: 1,
            occurred_on: new Date('2026-04-24T12:00:00.000Z'),
            payload: { jobId: 'job-1' },
            messageId: 'message-1',
        };

        await service.publishMessage(
            {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.jobs.created.CODE_REVIEW',
            },
            message,
            { messageId: 'custom-message-id' },
        );

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange',
            'workflow.jobs.created.CODE_REVIEW',
            message,
            expect.objectContaining({
                messageId: 'custom-message-id',
            }),
        );
    });

    it('falls back to the envelope messageId when options messageId is undefined', async () => {
        const { service, amqpConnection } = makeService();
        const message = {
            event_name: 'workflow.jobs.created',
            event_version: 1,
            occurred_on: new Date('2026-04-24T12:00:00.000Z'),
            payload: { jobId: 'job-1' },
            messageId: 'message-1',
        };

        await service.publishMessage(
            {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.jobs.created.CODE_REVIEW',
            },
            message,
            { messageId: undefined },
        );

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange',
            'workflow.jobs.created.CODE_REVIEW',
            message,
            expect.objectContaining({
                messageId: 'message-1',
            }),
        );
    });
});
