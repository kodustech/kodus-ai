import { MessageClaimService } from './message-claim.service';

describe('MessageClaimService', () => {
    let inbox: {
        claim: jest.Mock;
        markAsProcessed: jest.Mock;
        releaseIfHeldBy: jest.Mock;
    };
    let service: MessageClaimService;

    beforeEach(() => {
        inbox = {
            claim: jest.fn().mockResolvedValue({ messageId: 'k' }),
            markAsProcessed: jest.fn().mockResolvedValue(undefined),
            releaseIfHeldBy: jest.fn().mockResolvedValue(undefined),
        };
        service = new MessageClaimService(inbox as any);
    });

    it('claims the key on the inbox under the consumer, expiring after 15 minutes by default', async () => {
        await expect(service.claim('consumer-a', 'k')).resolves.toBe(true);

        expect(inbox.claim).toHaveBeenCalledWith(
            'k',
            'consumer-a',
            expect.any(String),
            undefined,
            15,
        );
    });

    it('passes a given expiry through', async () => {
        await service.claim('consumer-a', 'k', { expiresInMinutes: 5 });

        expect(inbox.claim.mock.calls[0][4]).toBe(5);
    });

    it('is refused when the inbox already has the key', async () => {
        inbox.claim.mockResolvedValue(null);

        await expect(service.claim('consumer-a', 'k')).resolves.toBe(false);
    });

    it('lets a failed claim surface to the caller', async () => {
        inbox.claim.mockRejectedValue(new Error('db down'));

        await expect(service.claim('consumer-a', 'k')).rejects.toThrow(
            'db down',
        );
    });

    it('marks the key processed on complete', async () => {
        await service.complete('consumer-a', 'k');

        expect(inbox.markAsProcessed).toHaveBeenCalledWith('k', 'consumer-a');
    });

    it('releases only a claim this instance holds, under the same lockedBy it claimed with', async () => {
        await service.claim('consumer-a', 'k');
        await service.release('consumer-a', 'k');

        const claimedBy = inbox.claim.mock.calls[0][2];
        expect(inbox.releaseIfHeldBy).toHaveBeenCalledWith(
            'k',
            'consumer-a',
            claimedBy,
        );
    });
});
