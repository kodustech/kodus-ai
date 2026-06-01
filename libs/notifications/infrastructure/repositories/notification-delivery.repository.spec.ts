import { Repository } from 'typeorm';

import { Criticality, DeliveryStatus, NotificationChannel } from '../../domain/enums';
import { NotificationDeliveryRepository } from './notification-delivery.repository';
import { NotificationDeliveryModel } from './schemas/notification-delivery.model';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Minimal typeorm Repository surface used by the repo under test.
const makeTypeOrmRepoMock = () => {
    const repo = {
        create: jest.fn((row: any) => row),
        save: jest.fn().mockImplementation(async (row: any) => ({
            ...row,
            uuid: row.uuid ?? 'd-saved',
        })),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        find: jest.fn().mockResolvedValue([]),
        query: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
    return repo as unknown as jest.Mocked<Repository<NotificationDeliveryModel>>;
};

describe('NotificationDeliveryRepository', () => {
    let typeOrmRepo: ReturnType<typeof makeTypeOrmRepoMock>;
    let repo: NotificationDeliveryRepository;

    beforeEach(() => {
        typeOrmRepo = makeTypeOrmRepoMock();
        repo = new NotificationDeliveryRepository(typeOrmRepo);
    });

    describe('updateStatus', () => {
        it('clears lock + retry fields on terminal DELIVERED + stamps deliveredAt', async () => {
            await repo.updateStatus('d-1', DeliveryStatus.DELIVERED);

            const [, update] = (typeOrmRepo.update as jest.Mock).mock.calls[0];
            expect(update.deliveryStatus).toBe(DeliveryStatus.DELIVERED);
            expect(update.lockedAt).toBeNull();
            expect(update.lockedBy).toBeNull();
            expect(update.nextAttemptAt).toBeNull();
            expect(update.deliveredAt).toBeInstanceOf(Date);
        });

        it('records lastError when provided', async () => {
            await repo.updateStatus('d-1', DeliveryStatus.FAILED, 'boom');
            const [, update] = (typeOrmRepo.update as jest.Mock).mock.calls[0];
            expect(update.lastError).toBe('boom');
        });
    });

    describe('scheduleRetry', () => {
        it('increments attempts atomically via createQueryBuilder', async () => {
            const where = jest.fn().mockReturnThis();
            const set = jest.fn().mockReturnThis();
            const update = jest.fn().mockReturnThis();
            const execute = jest.fn().mockResolvedValue(undefined);
            typeOrmRepo.createQueryBuilder.mockReturnValue({
                update,
                set,
                where,
                execute,
            } as any);

            const ts = new Date('2026-01-01T00:00:00Z');
            await repo.scheduleRetry('d-1', ts, 'transient error');

            // The set() payload should bump attempts via a SQL fragment
            // (not a value), and pass the timestamp/error through.
            const setArgs = set.mock.calls[0][0];
            expect(typeof setArgs.attempts).toBe('function');
            expect(setArgs.attempts()).toBe('"attempts" + 1');
            expect(setArgs.nextAttemptAt).toBe(ts);
            expect(setArgs.lastError).toBe('transient error');
            expect(setArgs.lockedAt).toBeNull();
            expect(setArgs.lockedBy).toBeNull();
            expect(setArgs.deliveryStatus).toBe(DeliveryStatus.PENDING);
            expect(where).toHaveBeenCalledWith({ uuid: 'd-1' });
            expect(execute).toHaveBeenCalled();
        });

        it('truncates a huge error message to 2000 chars', async () => {
            const set = jest.fn().mockReturnThis();
            typeOrmRepo.createQueryBuilder.mockReturnValue({
                update: jest.fn().mockReturnThis(),
                set,
                where: jest.fn().mockReturnThis(),
                execute: jest.fn().mockResolvedValue(undefined),
            } as any);

            const bigErr = 'x'.repeat(3000);
            await repo.scheduleRetry('d-1', new Date(), bigErr);
            expect(set.mock.calls[0][0].lastError.length).toBe(2000);
        });
    });

    describe('claimRetryBatch', () => {
        it('runs the SKIP LOCKED query and returns rebuilt models', async () => {
            typeOrmRepo.query.mockResolvedValueOnce([
                {
                    uuid: 'd-1',
                    event: 'kody_rules.generated',
                    criticality: 'informational',
                    channel: 'email',
                    title: 'T',
                    body: 'B',
                    category: 'kody_rules',
                    recipientEmail: 'a@b.com',
                    recipientRole: 'owner',
                    deliveryStatus: 'pending',
                    metadata: {},
                    correlationId: 'corr-1',
                    attempts: 2,
                    nextAttemptAt: new Date(),
                    organization_id: 'org-1',
                    recipient_user_id: 'user-1',
                },
            ]);

            const claimed = await repo.claimRetryBatch(50, 'worker-host');

            expect(typeOrmRepo.query).toHaveBeenCalledTimes(1);
            const [sql, params] = typeOrmRepo.query.mock.calls[0];
            // Lock recovery: include rows whose lockedAt is older than 5 min
            expect(sql).toMatch(/lockedAt.*NULL.*OR.*lockedAt.*INTERVAL '5 minutes'/s);
            // SKIP LOCKED for concurrency-safe claim
            expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
            // Bound params: lockedBy / status / limit
            expect(params).toEqual(['worker-host', DeliveryStatus.PENDING, 50]);
            expect(claimed).toHaveLength(1);
            expect(claimed[0].uuid).toBe('d-1');
        });

        it('returns an empty array when the query yields no rows', async () => {
            typeOrmRepo.query.mockResolvedValueOnce([]);
            const claimed = await repo.claimRetryBatch(50, 'worker');
            expect(claimed).toEqual([]);
        });
    });

    describe('create', () => {
        it('persists recipientRole alongside other fields', async () => {
            await repo.create({
                organization: { uuid: 'org-1' } as any,
                event: 'kody_rules.generated',
                criticality: Criticality.INFORMATIONAL,
                channel: NotificationChannel.IN_APP,
                title: 'T',
                body: 'B',
                category: 'kody_rules',
                recipientEmail: 'a@b.com',
                recipientRole: 'contributor',
                recipientUser: { uuid: 'user-1' } as any,
                deliveryStatus: DeliveryStatus.PENDING,
                metadata: {},
                correlationId: 'corr',
            });

            const created = typeOrmRepo.create.mock.calls[0][0];
            expect(created.recipientRole).toBe('contributor');
            expect(created.recipientEmail).toBe('a@b.com');
        });
    });
});
