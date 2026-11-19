import type { UltraReviewState } from '@libs/code-review/domain/ultra-review-state';

import {
    ultraDegradedNotice,
    ultraSaveRefusalMessage,
} from './ultra-review-messages';

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

    describe('with no model completed', () => {
        const failedWith = (findings?: number) =>
            ultraDegradedNotice(
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
                            ...(findings !== undefined && { findings }),
                        },
                    ],
                    outcome: 'failed',
                },
                { prNumber: 7 },
            );

        it('says the partial comments were posted when a model left some', () => {
            expect(failedWith(2)).toContain(
                'No model completed. The comments the models found before they stopped were posted.',
            );
        });

        it('says nothing was posted when none left comments', () => {
            expect(failedWith(0)).toContain(
                'No model completed, and none left comments to post.',
            );
            expect(failedWith()).toContain(
                'No model completed, and none left comments to post.',
            );
        });
    });
});

describe('ultraSaveRefusalMessage', () => {
    it.each([
        'plan' as const,
        { reason: 'too_few_models' as const, ownModels: 2 },
        { reason: 'not_configured' as const, ownModels: 3 },
        { reason: 'same_model' as const, ownModels: 3, model: 'm' },
        { reason: 'unavailable_models' as const, ownModels: 3 },
        { reason: 'some_unavailable' as const, ownModels: 3, unavailable: 1 },
    ])(
        'starts with "Ultra review", the prefix the web shows it on: %j',
        (refusal) => {
            expect(ultraSaveRefusalMessage(refusal)).toMatch(/^Ultra review/);
        },
    );
});
