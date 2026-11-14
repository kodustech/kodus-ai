import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
    parseModelTurnRequest,
    modelTurnSdkJson,
    parseModelTurnResponse,
    type ModelTurnRequest,
    type ModelTurnResponse,
    type ModelTurnScope,
} from '@libs/runtime/contracts/model-turn';

/** Pure framing only: transport, credentials, redaction and execution belong to later adapters. */
export function toModelTurnRequest(
    scope: ModelTurnScope,
    call: unknown,
): ModelTurnRequest {
    return parseModelTurnRequest({
        v: 1,
        scope,
        task: 'runtime.plan',
        toolset: 'runtime-planner-v1',
        call: modelTurnSdkJson(call),
    });
}

export function toSdkModelTurnCall(input: unknown): ModelTurnRequest['call'] {
    return parseModelTurnRequest(input).call;
}

export function toSdkModelTurnResult(
    request: unknown,
    input: unknown,
): {
    generation: LanguageModelV4GenerateResult;
    budget: ModelTurnResponse['budget'];
    /** At least one measured counter; totals can still be partially unknown. */
    usageReported: boolean;
} {
    const response = parseModelTurnResponse(input, request);
    const { usage, ...generation } = response.generation;
    // SDK unknowns stay undefined. A counted budget reservation is not provider usage.
    const inputTokens = usage.reported ? usage.inputTokens : undefined;
    const outputTokens = usage.reported ? usage.outputTokens : undefined;
    return {
        generation: {
            ...generation,
            finishReason: {
                ...generation.finishReason,
                raw: generation.finishReason.raw,
            },
            usage: {
                inputTokens: {
                    total: inputTokens?.total,
                    noCache: inputTokens?.noCache,
                    cacheRead: inputTokens?.cacheRead,
                    cacheWrite: inputTokens?.cacheWrite,
                },
                outputTokens: {
                    total: outputTokens?.total,
                    text: outputTokens?.text,
                    reasoning: outputTokens?.reasoning,
                },
            },
        },
        budget: response.budget,
        usageReported: usage.reported,
    };
}
