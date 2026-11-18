import type { UltraReviewState } from '@libs/code-review/domain/ultra-review-state';

import { ultraDegradedNotice } from './ultra-review-messages';

const model = (position: any, modelId: string) => ({
    position,
    modelId,
    modelName: `openai:${modelId}`,
    slot: {} as any,
});

describe('ultraDegradedNotice', () => {
    it('lists a model the config no longer resolves once, as the failed run it became', () => {
        const state: UltraReviewState = {
            models: [model(1, 'a'), model(3, 'c')],
            unavailable: [{ position: 2, modelId: 'gone', reason: 'Removed.' }],
            mergeModel: model(1, 'a'),
            runs: [
                {
                    position: 1,
                    modelId: 'a',
                    modelName: 'openai:a',
                    status: 'completed',
                },
                {
                    position: 2,
                    modelId: 'gone',
                    modelName: 'gone',
                    status: 'failed',
                    failureReason: 'Removed.',
                },
                {
                    position: 3,
                    modelId: 'c',
                    modelName: 'openai:c',
                    status: 'completed',
                },
            ],
            merge: { status: 'success', inputCount: 2, outputCount: 2 },
            outcome: 'degraded',
        };
        const notice = ultraDegradedNotice(state, { prNumber: 7 });
        expect(notice.match(/gone/g)).toHaveLength(1);
        expect(notice).toContain('Model 2 (`gone`) failed: Removed.');
    });

    it("with no model completed, says the models' comments were not posted (Kody Rules may have been)", () => {
        const notice = ultraDegradedNotice(
            {
                models: [model(1, 'a')],
                mergeModel: model(1, 'a'),
                runs: [
                    {
                        position: 1,
                        modelId: 'a',
                        modelName: 'openai:a',
                        status: 'failed',
                        failureReason: 'Down.',
                    },
                ],
                outcome: 'failed',
            },
            { prNumber: 7 },
        );
        expect(notice).toContain(
            "No model completed, so the models' comments were not posted.",
        );
    });
});
