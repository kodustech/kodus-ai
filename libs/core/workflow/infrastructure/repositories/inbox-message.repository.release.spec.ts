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
