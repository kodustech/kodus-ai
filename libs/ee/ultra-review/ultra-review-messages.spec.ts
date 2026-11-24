import type { UltraReviewState } from '@libs/code-review/domain/ultra-review-state';

import {
    ultraDegradedNotice,
    ultraFallbackInfoLine,
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

const run = (
    position: 1 | 2 | 3 | 'fallback',
    modelId: string,
    status: 'completed' | 'failed',
    extra: Record<string, unknown> = {},
) => ({
    position,
    modelId,
    modelName: `openai:${modelId}`,
    status,
    ...extra,
});

describe('ultraDegradedNotice with Kody Rules left behind', () => {
    it('says their comments are missing, though the three models completed', () => {
        const notice = ultraDegradedNotice(
            {
                models: [model(1, 'a'), model(2, 'b'), model(3, 'c')],
                mergeModel: model(1, 'a'),
                runs: [
                    run(1, 'a', 'completed'),
                    run(2, 'b', 'completed'),
                    run(3, 'c', 'completed'),
                ] as any,
                merge: { status: 'success', inputCount: 3, outputCount: 3 },
                auxiliaryMissed: true,
                outcome: 'degraded',
            },
            { prNumber: 7 },
        );
        expect(notice).toContain(
            'Kody Rules and custom agents did not finish in time',
        );
        expect(notice).toContain('Automatic approval is held');
    });
});

describe('ultraFallbackInfoLine', () => {
    const replacedBy = (fallback: 'completed' | 'failed', outcome: any) =>
        ultraFallbackInfoLine({
            models: [model(1, 'a'), model(2, 'b'), model(3, 'c')],
            fallback: model('fallback', 'f'),
            mergeModel: model(1, 'a'),
            runs: [
                run(1, 'a', 'completed'),
                run(2, 'b', 'failed', { replacedBy: 'f' }),
                run(3, 'c', 'completed'),
                run('fallback', 'f', fallback),
            ] as any,
            outcome,
        });

    it('says the fallback took the place of a failed model when the review succeeded', () => {
        expect(replacedBy('completed', 'success')).toContain(
            'the fallback `openai:f` took its place',
        );
    });

    it('says nothing when the fallback failed too: the notice tells it', () => {
        expect(replacedBy('failed', 'degraded')).toBeUndefined();
    });
});

describe('ultraSaveRefusalMessage', () => {
    it.each([
        ['plan' as const, 'Teams and Enterprise plans'],
        ['plan_unreadable' as const, "could not read this organization's plan"],
        [{ reason: 'too_few_models' as const, ownModels: 2 }, 'has 2,'],
        [
            { reason: 'not_configured' as const, ownModels: 3 },
            'three different models set under Ultra models',
        ],
        [
            { reason: 'same_model' as const, ownModels: 3, model: 'model-x' },
            'model-x',
        ],
        [
            { reason: 'unavailable_models' as const, ownModels: 3 },
            'any of the three models set for it any more',
        ],
        [
            {
                reason: 'some_unavailable' as const,
                ownModels: 3,
                unavailable: 2,
            },
            'cannot run on 2 of the three models',
        ],
    ])(
        'starts with "Ultra review", the prefix the web shows it on, and names its own reason: %j',
        (refusal, fragment) => {
            const message = ultraSaveRefusalMessage(refusal);
            expect(message).toMatch(/^Ultra review/);
            expect(message).toContain(fragment);
        },
    );
});
