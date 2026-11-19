import { InboxMessageRepository } from './inbox-message.repository';
import { InboxStatus } from './schemas/inbox-message.model';

describe('InboxMessageRepository.heartbeat', () => {
    it('touches lockedAt only while this holder still has the message in PROCESSING', async () => {
        const update = jest.fn().mockResolvedValue({ affected: 1 });
        const repository = new InboxMessageRepository({ update } as any);

        await expect(
            repository.heartbeat('k', 'consumer-a', 'worker-1'),
        ).resolves.toBe(true);

        expect(update).toHaveBeenCalledWith(
            {
                messageId: 'k',
                consumerId: 'consumer-a',
                lockedBy: 'worker-1',
                status: InboxStatus.PROCESSING,
            },
            { lockedAt: expect.any(Date) },
        );
    });

    it('returns false when the claim was stolen or completed', async () => {
        const update = jest.fn().mockResolvedValue({ affected: 0 });
        const repository = new InboxMessageRepository({ update } as any);

        await expect(
            repository.heartbeat('k', 'consumer-a', 'worker-1'),
        ).resolves.toBe(false);
    });
});
