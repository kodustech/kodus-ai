import type { ReviewAgentOutput } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { ReviewContextDelivery } from '@libs/cli-review/domain/types/review-context.types';
import {
    collectBatchReviewContextDeliveries,
    runChunkedReview,
} from '@libs/code-review/infrastructure/agents/collaborators/batch-runner';

function result(
    agentName: string,
    deliveries?: ReviewContextDelivery[],
): ReviewAgentOutput {
    return {
        suggestions: [],
        agentName,
        turnsUsed: 1,
        durationMs: 1,
        ...(deliveries ? { reviewContextDeliveries: deliveries } : {}),
    };
}

describe('collectBatchReviewContextDeliveries', () => {
    it('preserves delivery evidence from every completed review batch', () => {
        const first = {
            source: 'cli-review-context-file',
            contentType: 'text/plain; charset=utf-8',
            sha256: 'a'.repeat(64),
            utf8Bytes: 12,
            recipient: 'bug batch 1/2',
            phase: 'finder',
        } satisfies ReviewContextDelivery;
        const second = {
            ...first,
            recipient: 'bug batch 2/2',
            phase: 'verifier',
        } satisfies ReviewContextDelivery;

        const deliveries = collectBatchReviewContextDeliveries([
            result('bug batch 1/2', [first]),
            result('bug batch 2/2', [second]),
            result('context-free batch'),
        ]);

        expect(deliveries).toEqual([first, second]);
    });

    it('returns undefined when no batch delivered review context', () => {
        expect(
            collectBatchReviewContextDeliveries([result('context-free batch')]),
        ).toBeUndefined();
    });
});

describe('runChunkedReview review context receipts', () => {
    it('reports actual deliveries from successful and post-delivery-failing batches', async () => {
        const deliveries: ReviewContextDelivery[] = [];
        const input = {
            prNumber: 1869,
            changedFiles: [
                { filename: 'src/one.ts', patch: 'x'.repeat(200) },
                { filename: 'src/two.ts', patch: 'y'.repeat(200) },
            ],
            onReviewContextDelivery: (delivery: ReviewContextDelivery) => {
                deliveries.push(delivery);
            },
        } as unknown as Parameters<typeof runChunkedReview>[0];
        const runBatch = jest.fn(
            async (
                batchInput: Parameters<typeof runChunkedReview>[0],
            ): Promise<ReviewAgentOutput> => {
                const batchIndex = batchInput.batchIndex ?? 0;
                const delivery = {
                    source: 'cli-review-context-file',
                    contentType: 'text/plain; charset=utf-8',
                    sha256: String(batchIndex).repeat(64),
                    utf8Bytes: 20,
                    recipient: `bug batch ${batchIndex}/2`,
                    phase: 'finder',
                } satisfies ReviewContextDelivery;
                batchInput.onReviewContextDelivery?.(delivery);
                if (batchIndex === 2) {
                    throw new Error('provider failed after delivery');
                }
                return result(`bug batch ${batchIndex}/2`);
            },
        );

        const output = await runChunkedReview(input, {
            identity: {
                name: 'bug',
                description: 'bug finder',
                goal: 'find bugs',
                expertise: ['correctness'],
            },
            agentCategory: 'bug',
            startTime: Date.now(),
            diffBudget: 1,
            runBatch,
            logger: { log: jest.fn(), error: jest.fn() },
        });

        expect(runBatch).toHaveBeenCalledTimes(2);
        expect(output.reviewContextDeliveries).toEqual(deliveries);
        expect(output.reviewContextDeliveries).toHaveLength(2);
    });
});
