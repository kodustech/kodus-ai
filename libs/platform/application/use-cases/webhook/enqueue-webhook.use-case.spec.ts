import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { EnqueueWebhookUseCase } from './enqueue-webhook.use-case';

describe('EnqueueWebhookUseCase', () => {
    it('creates a stable idempotency key from the provider delivery id', async () => {
        const queue = { enqueue: jest.fn().mockResolvedValue('job-1') };
        const useCase = new EnqueueWebhookUseCase(queue as any);
        const input = {
            platformType: PlatformType.GITHUB,
            event: 'pull_request',
            payload: { action: 'opened' },
            deliveryId: 'delivery-123',
        };

        await expect(useCase.execute(input)).resolves.toBe('job-1');
        await useCase.execute(input);

        expect(queue.enqueue.mock.calls[0][0].idempotencyKey).toBe(
            queue.enqueue.mock.calls[1][0].idempotencyKey,
        );
        expect(queue.enqueue.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                maxRetries: 1,
                metadata: expect.objectContaining({
                    deliveryId: 'delivery-123',
                }),
            }),
        );
    });

    it('does not dedupe providers that omit a delivery id', async () => {
        const queue = { enqueue: jest.fn().mockResolvedValue('job-1') };
        const useCase = new EnqueueWebhookUseCase(queue as any);

        await useCase.execute({
            platformType: PlatformType.BITBUCKET,
            event: 'pr:opened',
            payload: {},
        });

        expect(queue.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: undefined }),
        );
    });
});
