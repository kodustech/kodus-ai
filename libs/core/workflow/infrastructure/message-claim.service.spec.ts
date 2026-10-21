import { MessageClaimService } from './message-claim.service';

describe('MessageClaimService', () => {
    let inbox: {
        claim: jest.Mock;
        completeIfHeldBy: jest.Mock;
        releaseIfHeldBy: jest.Mock;
    };
    let service: MessageClaimService;

    beforeEach(() => {
        inbox = {
            claim: jest.fn().mockResolvedValue({ messageId: 'k' }),
            completeIfHeldBy: jest.fn().mockResolvedValue(undefined),
            releaseIfHeldBy: jest.fn().mockResolvedValue(undefined),
        };
        service = new MessageClaimService(inbox as any);
    });

    it('claims the key on the inbox under the consumer, expiring after 15 minutes by default', async () => {
        const holder = await service.claim('consumer-a', 'k');

        expect(holder).toEqual(expect.any(String));
        expect(inbox.claim).toHaveBeenCalledWith(
            'k',
            'consumer-a',
            holder,
            undefined,
            15,
        );
    });

    it('passes a given expiry through', async () => {
        await service.claim('consumer-a', 'k', { expiresInMinutes: 5 });

        expect(inbox.claim.mock.calls[0][4]).toBe(5);
    });

    it('gives every attempt its own holder, even on the same instance', async () => {
        const first = await service.claim('consumer-a', 'k');
        const second = await service.claim('consumer-a', 'k');

        expect(first).not.toEqual(second);
    });

    it('returns null when the inbox already has the key', async () => {
        inbox.claim.mockResolvedValue(null);

        await expect(service.claim('consumer-a', 'k')).resolves.toBeNull();
    });

    it('lets a failed claim surface to the caller', async () => {
        inbox.claim.mockRejectedValue(new Error('db down'));

        await expect(service.claim('consumer-a', 'k')).rejects.toThrow(
            'db down',
        );
    });

    it('completes only for the holder that claimed', async () => {
        const holder = await service.claim('consumer-a', 'k');
        await service.complete('consumer-a', 'k', holder);

        expect(inbox.completeIfHeldBy).toHaveBeenCalledWith(
            'k',
            'consumer-a',
            holder,
        );
    });

    it('releases only for the holder that claimed', async () => {
        const holder = await service.claim('consumer-a', 'k');
        await service.release('consumer-a', 'k', holder);

        expect(inbox.releaseIfHeldBy).toHaveBeenCalledWith(
            'k',
            'consumer-a',
            holder,
        );
    });
});
