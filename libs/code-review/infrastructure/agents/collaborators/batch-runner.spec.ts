import type { ReviewAgentOutput } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { ReviewContextDelivery } from '@libs/cli-review/domain/types/review-context.types';
import { collectBatchReviewContextDeliveries } from '@libs/code-review/infrastructure/agents/collaborators/batch-runner';

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
