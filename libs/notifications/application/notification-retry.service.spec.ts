import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { INotificationDeliveryRepository } from '../domain/contracts/notification-delivery.repository.contract';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationRetryService } from './notification-retry.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('NotificationRetryService.tick', () => {
    let deliveryRepo: jest.Mocked<INotificationDeliveryRepository>;
    let dispatcher: jest.Mocked<Pick<NotificationDispatcherService, 'redeliver'>>;
    let lockService: jest.Mocked<Pick<DistributedLockService, 'acquire'>>;
    let lock: jest.Mocked<Pick<DistributedLock, 'release'>>;
    let service: NotificationRetryService;

    beforeEach(() => {
        deliveryRepo = {
            create: jest.fn(),
            updateStatus: jest.fn(),
            scheduleRetry: jest.fn(),
            claimRetryBatch: jest.fn(),
            findByCorrelationId: jest.fn(),
        };
        dispatcher = { redeliver: jest.fn().mockResolvedValue(undefined) };
        lock = { release: jest.fn().mockResolvedValue(undefined) };
        lockService = {
            acquire: jest.fn().mockResolvedValue(lock as DistributedLock),
        };

        service = new NotificationRetryService(
            deliveryRepo,
            dispatcher as NotificationDispatcherService,
            lockService as DistributedLockService,
        );
    });

    it('exits early when another pod holds the lock', async () => {
        lockService.acquire.mockResolvedValueOnce(null);

        await service.tick();

        expect(deliveryRepo.claimRetryBatch).not.toHaveBeenCalled();
        expect(dispatcher.redeliver).not.toHaveBeenCalled();
    });

    it('does nothing when claimRetryBatch returns empty', async () => {
        deliveryRepo.claimRetryBatch.mockResolvedValueOnce([]);

        await service.tick();

        expect(dispatcher.redeliver).not.toHaveBeenCalled();
        expect(lock.release).toHaveBeenCalled();
    });

    it('passes claimed deliveries to dispatcher.redeliver with attempts+1', async () => {
        deliveryRepo.claimRetryBatch
            .mockResolvedValueOnce([
                { uuid: 'd-1', attempts: 2 } as any,
                { uuid: 'd-2', attempts: 4 } as any,
            ])
            .mockResolvedValueOnce([]); // second drain pass returns empty

        await service.tick();

        expect(dispatcher.redeliver).toHaveBeenCalledTimes(2);
        expect(dispatcher.redeliver).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'd-1' }),
            3,
        );
        expect(dispatcher.redeliver).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'd-2' }),
            5,
        );
    });

    it('keeps draining batches until claimRetryBatch returns empty', async () => {
        deliveryRepo.claimRetryBatch
            .mockResolvedValueOnce([{ uuid: 'd-1', attempts: 0 } as any])
            .mockResolvedValueOnce([{ uuid: 'd-2', attempts: 0 } as any])
            .mockResolvedValueOnce([]);

        await service.tick();

        expect(deliveryRepo.claimRetryBatch).toHaveBeenCalledTimes(3);
        expect(dispatcher.redeliver).toHaveBeenCalledTimes(2);
    });

    it('always releases the lock, even when drainBatches throws', async () => {
        deliveryRepo.claimRetryBatch.mockRejectedValueOnce(
            new Error('db lost'),
        );

        await service.tick();

        expect(lock.release).toHaveBeenCalled();
    });

    it('does not throw when acquire itself rejects', async () => {
        lockService.acquire.mockRejectedValueOnce(new Error('pg down'));

        await expect(service.tick()).resolves.not.toThrow();
        expect(deliveryRepo.claimRetryBatch).not.toHaveBeenCalled();
    });
});
