import { EnqueueCliReviewUseCase } from './enqueue-cli-review.use-case';
import type { IJobQueueService } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';

const reviewContext = {
    source: 'cli-review-context-file' as const,
    contentType: 'text/plain; charset=utf-8' as const,
    body: 'CANARY: inspect cleanup',
};

function createQueue(): jest.Mocked<IJobQueueService> {
    return {
        enqueue: jest.fn().mockResolvedValue('job-ordinary'),
        enqueueEphemeral: jest.fn().mockResolvedValue('job-context'),
        getStatus: jest.fn(),
        listJobs: jest.fn(),
    };
}

describe('EnqueueCliReviewUseCase review context', () => {
    it('keeps context out of the durable job and sends it as ephemeral transport', async () => {
        const queue = createQueue();
        const useCase = new EnqueueCliReviewUseCase(queue);

        await useCase.execute({
            correlationId: 'correlation-1',
            organizationAndTeamData: {
                organizationId: 'organization-1',
                teamId: 'team-1',
            },
            input: { diff: 'diff', reviewContext },
        });

        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(queue.enqueueEphemeral).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    input: { diff: 'diff' },
                }),
            }),
            { reviewContext },
        );
        expect(
            JSON.stringify(queue.enqueueEphemeral.mock.calls[0]?.[0]),
        ).not.toContain(reviewContext.body);
    });

    it('uses the existing durable outbox path when context is absent', async () => {
        const queue = createQueue();
        const useCase = new EnqueueCliReviewUseCase(queue);

        await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'organization-1',
                teamId: 'team-1',
            },
            input: { diff: 'diff' },
        });

        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(queue.enqueueEphemeral).not.toHaveBeenCalled();
    });
});
