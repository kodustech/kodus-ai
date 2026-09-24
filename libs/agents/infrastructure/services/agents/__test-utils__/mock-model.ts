import { MockLanguageModelV3 } from 'ai/test';

/**
 * Shared mock-model factory for the agent wiring specs (post removal:
 * the agents now drive the AI SDK directly, so the tests mock at the model seam).
 *
 * Two things this centralises:
 *  1. The `doGenerate` return is annotated with the SDK's own result type
 *     (derived FROM the mock, so it tracks whichever `@ai-sdk/provider` copy the
 *     installed `ai/test` resolves). Without the annotation the constructor's
 *     UNION param type (`doGenerate | Result | Result[]`) defeats contextual
 *     typing of an inline literal, which then widens and fails to type-check.
 *  2. The result is built in the CURRENT provider shape — `finishReason` is the
 *     `{ unified, raw }` object and `usage` is the nested input/output-token
 *     breakdown — not the old flat shape the specs were originally written for.
 *     Callers still pass a friendly `{ inputTokens, outputTokens }` total.
 */
type DoGenerate = NonNullable<
    ConstructorParameters<typeof MockLanguageModelV3>[0]
>['doGenerate'];
type V3GenerateResult = Awaited<
    ReturnType<Extract<DoGenerate, (...args: never[]) => unknown>>
>;

/** A model that answers with `text` as a single assistant turn (finish reason
 *  'stop'), or an empty turn when `text` is falsy. */
export function mockTextModel(
    text: string,
    {
        inputTokens,
        outputTokens,
    }: { inputTokens: number; outputTokens: number } = {
        inputTokens: 10,
        outputTokens: 5,
    },
): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async (): Promise<V3GenerateResult> => ({
            content: text ? [{ type: 'text', text }] : [],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
                inputTokens: {
                    total: inputTokens,
                    noCache: inputTokens,
                    cacheRead: 0,
                    cacheWrite: 0,
                },
                outputTokens: {
                    total: outputTokens,
                    text: outputTokens,
                    reasoning: 0,
                },
            },
            warnings: [],
        }),
    });
}
