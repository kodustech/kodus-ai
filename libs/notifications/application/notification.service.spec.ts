import { IMessageBrokerService } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';

import { NotificationEvent } from '../domain/catalog/events';
import { NotificationService } from './notification.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('NotificationService.emit', () => {
    let messageBroker: jest.Mocked<
        Pick<IMessageBrokerService, 'transformMessageToMessageBroker'>
    >;
    let outboxRepository: jest.Mocked<
        Pick<IOutboxMessageRepository, 'create'>
    >;
    let metricsCollector: jest.Mocked<
        Pick<MetricsCollectorService, 'recordCounter'>
    >;
    let service: NotificationService;

    beforeEach(() => {
        messageBroker = {
            transformMessageToMessageBroker: jest.fn((args) => args.message),
        };
        outboxRepository = { create: jest.fn().mockResolvedValue(undefined) };
        metricsCollector = { recordCounter: jest.fn() };
        service = new NotificationService(
            messageBroker as unknown as IMessageBrokerService,
            outboxRepository as unknown as IOutboxMessageRepository,
            metricsCollector as unknown as MetricsCollectorService,
        );
    });

    it('writes a single outbox row with the routing key and recipients on emit', async () => {
        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: {
                email: 'a@b.com',
                name: 'Acme',
                token: 't',
            },
            organizationId: 'org-1',
            recipients: { kind: 'user', userId: 'user-1' },
            correlationId: 'corr-1',
        });

        expect(outboxRepository.create).toHaveBeenCalledTimes(1);
        expect(outboxRepository.create).toHaveBeenCalledWith({
            exchange: 'notification.exchange',
            routingKey: 'notification.auth.forgot_password',
            payload: expect.objectContaining({
                event: NotificationEvent.AUTH_FORGOT_PASSWORD,
                organizationId: 'org-1',
                recipients: [{ kind: 'user', userId: 'user-1' }],
                correlationId: 'corr-1',
            }),
        });
    });

    it('normalizes a single recipient into an array on the wire', async () => {
        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: { email: 'a@b.com', name: 'Acme', token: 't' },
            organizationId: 'org-1',
            recipients: { kind: 'user', userId: 'user-1' },
        });

        const call = outboxRepository.create.mock.calls[0][0];
        expect(Array.isArray((call.payload as any).recipients)).toBe(true);
        expect((call.payload as any).recipients).toHaveLength(1);
    });

    it('passes through an array of recipients unchanged', async () => {
        const recipients = [
            { kind: 'user' as const, userId: 'user-1' },
            { kind: 'role' as const, role: 'owner' as any },
        ];

        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: { email: 'a@b.com', name: 'Acme', token: 't' },
            organizationId: 'org-1',
            recipients,
        });

        const call = outboxRepository.create.mock.calls[0][0];
        expect((call.payload as any).recipients).toEqual(recipients);
    });

    it('skips the emit (no outbox row, warn log) when recipients is empty', async () => {
        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: { email: 'a@b.com', name: 'Acme', token: 't' },
            organizationId: 'org-1',
            recipients: [],
        });

        expect(outboxRepository.create).not.toHaveBeenCalled();
    });

    it('auto-generates a correlationId when caller does not pass one', async () => {
        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: { email: 'a@b.com', name: 'Acme', token: 't' },
            organizationId: 'org-1',
            recipients: { kind: 'user', userId: 'user-1' },
        });

        const call = outboxRepository.create.mock.calls[0][0];
        const correlationId = (call.payload as any).correlationId;
        expect(typeof correlationId).toBe('string');
        expect(correlationId.length).toBeGreaterThan(0);
    });

    it('records the notifications_emitted_total counter with event + criticality labels', async () => {
        await service.emit({
            event: NotificationEvent.AUTH_FORGOT_PASSWORD,
            payload: { email: 'a@b.com', name: 'Acme', token: 't' },
            organizationId: 'org-1',
            recipients: { kind: 'user', userId: 'user-1' },
        });

        expect(metricsCollector.recordCounter).toHaveBeenCalledWith(
            'notifications_emitted_total',
            1,
            {
                event: NotificationEvent.AUTH_FORGOT_PASSWORD,
                // auth.forgot_password is SYSTEM in the catalog
                criticality: 'system',
            },
        );
    });

    it('does not throw when metrics collector is absent (optional dep)', async () => {
        const sansMetrics = new NotificationService(
            messageBroker as unknown as IMessageBrokerService,
            outboxRepository as unknown as IOutboxMessageRepository,
        );

        await expect(
            sansMetrics.emit({
                event: NotificationEvent.AUTH_FORGOT_PASSWORD,
                payload: { email: 'a@b.com', name: 'Acme', token: 't' },
                organizationId: 'org-1',
                recipients: { kind: 'user', userId: 'user-1' },
            }),
        ).resolves.not.toThrow();
    });
});
