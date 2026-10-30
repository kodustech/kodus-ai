import { MockLanguageModelV3 } from 'ai/test';

/**
 * Shared scripted tool-call model for the harness e2e specs.
 *
 * WHY THIS EXISTS — the CURRENT `@ai-sdk/provider` (LanguageModelV3) shape:
 *  - `finishReason` is the `{ unified, raw }` object, NOT a bare string.
 *  - `usage` is the nested input/output-token breakdown, NOT flat numbers.
 *
 * A bare-string `finishReason: 'tool-calls'` no longer populates
 * `finishReason.unified`, so from ai@7.0.70 on the loop reads it as `undefined`
 * and `isToolExecutionAllowedFinishReason` blocks automatic tool execution
 * (allowlist = `stop` | `tool-calls`). The tool call is then requested but never
 * run, and the multi-step loop stalls at step 0. Centralising the shape here
 * keeps every spec faithful to the provider contract and stops the drift that
 * caused that break (previously each spec hand-rolled a flat mock).
 */

/** One tool call the scripted model emits on a given (1-based) turn. */
export interface ScriptedToolCall {
    id: string;
    name: string;
    input: unknown;
}

/**
 * A MockLanguageModelV3 that emits exactly one tool call per turn, in the shape
 * a real provider produces. `script(turn)` picks the tool call for the 1-based
 * turn number (turn 1 = first model call).
 */
export function scriptedToolModel(
    script: (turn: number) => ScriptedToolCall,
): MockLanguageModelV3 {
    let turn = 0;
    return new MockLanguageModelV3({
        doGenerate: (async () => {
            turn += 1;
            const tc = script(turn);
            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: tc.id,
                        toolName: tc.name,
                        input: JSON.stringify(tc.input),
                    },
                ],
                // The provider shape: `{ unified, raw }`, so `finishReason.unified`
                // === 'tool-calls' and the SDK's tool-execution gate allows the run.
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: {
                    inputTokens: {
                        total: 10,
                        noCache: 10,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                warnings: [],
            };
        }) as any,
    });
}
