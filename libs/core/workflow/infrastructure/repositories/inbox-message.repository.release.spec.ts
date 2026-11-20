import { InboxMessageRepository } from './inbox-message.repository';
import { InboxStatus } from './schemas/inbox-message.model';

describe('InboxMessageRepository.releaseIfHeldBy', () => {
    it('reopens the message only while the given holder still has it in PROCESSING', async () => {
        const update = jest.fn().mockResolvedValue({ affected: 0 });
        const repository = new InboxMessageRepository({ update } as any);

        await repository.releaseIfHeldBy('k', 'consumer-a', 'worker-1');

        // A PROCESSED row, or one another holder took over, matches nothing.
        expect(update).toHaveBeenCalledWith(
            {
                messageId: 'k',
                consumerId: 'consumer-a',
                lockedBy: 'worker-1',
                status: InboxStatus.PROCESSING,
            },
            { status: InboxStatus.READY, lockedBy: null, lockedAt: null },
        );
    });
});

describe('InboxMessageRepository.completeIfHeldBy', () => {
    it('completes the message only while the given holder still has it in PROCESSING', async () => {
        const update = jest.fn().mockResolvedValue({ affected: 0 });
        const repository = new InboxMessageRepository({ update } as any);

        await repository.completeIfHeldBy('k', 'consumer-a', 'worker-1');

        expect(update).toHaveBeenCalledWith(
            {
                messageId: 'k',
                consumerId: 'consumer-a',
                lockedBy: 'worker-1',
                status: InboxStatus.PROCESSING,
            },
            expect.objectContaining({ status: InboxStatus.PROCESSED }),
        );
    });
});

describe('InboxMessageRepository.staleHoldersByConsumer', () => {
    it('groups the stale PROCESSING messages by holder, most first', async () => {
        const qb: any = {};
        for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy'])
            qb[m] = jest.fn().mockReturnValue(qb);
        qb.getRawMany = jest.fn().mockResolvedValue([
            {
                lockedBy: 'a',
                count: '2',
                oldest: new Date('2026-11-19T11:00:00Z'),
                newest: new Date('2026-11-19T11:05:00Z'),
            },
            {
                lockedBy: 'b',
                count: '9',
                oldest: '2026-11-19T11:01:00Z',
                newest: '2026-11-19T11:09:00Z',
            },
            { lockedBy: null, count: 1, oldest: null, newest: null },
        ]);
        const repository = new InboxMessageRepository({
            createQueryBuilder: jest.fn().mockReturnValue(qb),
        } as any);
        const olderThan = new Date('2026-11-19T11:40:00Z');

        const holders = await repository.staleHoldersByConsumer('c', olderThan);

        expect(qb.where).toHaveBeenCalledWith('m.consumerId = :consumerId', {
            consumerId: 'c',
        });
        expect(qb.andWhere).toHaveBeenCalledWith('m.status = :status', {
            status: InboxStatus.PROCESSING,
        });
        expect(qb.andWhere).toHaveBeenCalledWith('m.lockedAt < :olderThan', {
            olderThan,
        });
        expect(holders).toEqual([
            {
                lockedBy: 'b',
                count: 9,
                oldestLockedAt: '2026-11-19T11:01:00.000Z',
                newestLockedAt: '2026-11-19T11:09:00.000Z',
            },
            {
                lockedBy: 'a',
                count: 2,
                oldestLockedAt: '2026-11-19T11:00:00.000Z',
                newestLockedAt: '2026-11-19T11:05:00.000Z',
            },
            {
                lockedBy: 'unknown',
                count: 1,
                oldestLockedAt: undefined,
                newestLockedAt: undefined,
            },
        ]);
    });
});
