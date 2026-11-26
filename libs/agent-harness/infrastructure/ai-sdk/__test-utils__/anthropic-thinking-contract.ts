import { MockLanguageModelV3 } from 'ai/test';

import type { ScriptedToolCall } from './scripted-tool-model';

/**
 * Anthropic's preserved-thinking check, replayed against recorded requests.
 *
 * A thinking block is bound to the request that produced it: the messages
 * before it and the tool list. When a later request replays the block after
 * either changed, Anthropic answers 400 "Invalid `signature` in `thinking`
 * block" (seen in production on review batches after compression, and on a
 * changed tool list in #2731). Unit tests of a policy cannot see this; a run
 * through the real runner with this model can.
 */
export interface RecordedCall {
    /** The prompt the model received (LanguageModelV3 messages). */
    prompt: any[];
    /** Names of the tools sent with the request, sorted. */
    tools: string[];
}

/**
 * A model that emits, on every turn, a thinking block signed `sig-<turn>` and
 * the tool call `script(turn)` picks, and records every request it receives.
 */
export function signedThinkingModel(
    script: (turn: number) => ScriptedToolCall,
): { model: MockLanguageModelV3; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    let turn = 0;
    const model = new MockLanguageModelV3({
        doGenerate: (async (params: any) => {
            turn += 1;
            calls.push({
                prompt: JSON.parse(JSON.stringify(params.prompt ?? [])),
                tools: (params.tools ?? []).map((t: any) => t.name).sort(),
            });
            const tc = script(turn);
            return {
                content: [
                    {
                        type: 'reasoning',
                        text: `thinking ${turn}`,
                        providerMetadata: {
                            anthropic: { signature: `sig-${turn}` },
                        },
                    },
                    {
                        type: 'tool-call',
                        toolCallId: tc.id,
                        toolName: tc.name,
                        input: JSON.stringify(tc.input),
                    },
                ],
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                warnings: [],
            };
        }) as any,
    });
    return { model, calls };
}

/** Cache markers may move freely (Anthropic ignores them for the check). */
function withoutCacheMarkers(messages: any[]): string {
    return JSON.stringify(messages, (key, value) =>
        key === 'cacheControl' || key === 'cache_control' ? undefined : value,
    );
}

/** The signed thinking blocks each request replays, as `sig-N` per call. */
export function replayedSignatures(calls: RecordedCall[]): string[][] {
    return calls.map((call) =>
        call.prompt.flatMap((msg: any) =>
            msg.role === 'assistant' && Array.isArray(msg.content)
                ? msg.content
                      .filter((p: any) => p.type === 'reasoning')
                      .map((p: any) => p.providerOptions?.anthropic?.signature)
                      .filter(Boolean)
                : [],
        ),
    );
}

/**
 * Every replayed block whose prefix or tool list differs from the request
 * that produced it: what Anthropic would reject. Empty means the run passes.
 */
export function thinkingContractViolations(calls: RecordedCall[]): string[] {
    const violations: string[] = [];
    calls.forEach((call, k) => {
        call.prompt.forEach((msg: any, m: number) => {
            if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
            for (const part of msg.content) {
                const sig: unknown = part?.providerOptions?.anthropic?.signature;
                if (part?.type !== 'reasoning' || typeof sig !== 'string') continue;
                const origin = calls[Number(sig.slice('sig-'.length)) - 1];
                if (!origin) {
                    violations.push(`call ${k + 1}: unknown block ${sig}`);
                    continue;
                }
                if (
                    withoutCacheMarkers(call.prompt.slice(0, m)) !==
                    withoutCacheMarkers(origin.prompt)
                ) {
                    violations.push(`call ${k + 1}: ${sig} replayed after its prefix changed`);
                }
                if (JSON.stringify(call.tools) !== JSON.stringify(origin.tools)) {
                    violations.push(`call ${k + 1}: ${sig} replayed with a different tool list`);
                }
            }
        });
    });
    return violations;
}
