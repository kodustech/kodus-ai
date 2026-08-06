/**
 * Wiring proof: the runner actually stamps the cache hint onto the tools + the
 * latest user message it hands the model — but ONLY on a multi-step run whose
 * provider supplied an inline-cache hint. Uses a capturing MockLanguageModelV3
 * so we read the exact lowered call options the SDK produced.
 */
import { MockLanguageModelV3 } from 'ai/test';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ModelResolver } from '../../domain/contracts/model.contract';
import type { ToolContext, AgentTool } from '../../domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const HINT = { anthropic: { cacheControl: { type: 'ephemeral' } } };

const echoTool: AgentTool = {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => ({ output: 'ok' }),
};
const doneTool: AgentTool = {
    name: 'submitResult',
    description: 'finalize',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'done' }),
};

// Captures the last lowered call options, then finalizes immediately so the
// loop ends after one model call.
function capturingModel(capture: { options?: any }) {
    const doGenerate = (async (options: any) => {
        capture.options = options;
        return {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: 'c1',
                    toolName: 'submitResult',
                    input: '{}',
                },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
        };
    }) as any;
    return new MockLanguageModelV3({ doGenerate });
}

const ctx: ToolContext = { runId: 'wiring-1' };

function baseSpec(over: Partial<AgentSpec>): AgentSpec {
    return {
        id: 'finder',
        systemPrompt: 'find bugs',
        modelId: 'mock',
        tools: new InMemoryToolRegistry([echoTool, doneTool]),
        policies: [],
        maxSteps: 4,
        ...over,
    } as AgentSpec;
}

// Deep-scan the lowered options for an anthropic ephemeral cache marker on any
// tool / prompt message — resilient to the exact V3 lowering shape.
const hasCacheMarker = (node: any): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (node?.anthropic?.cacheControl?.type === 'ephemeral') return true;
    return Object.values(node).some(hasCacheMarker);
};

describe('runner cache-policy wiring', () => {
    it('marks tools + latest user message on a multi-step run WITH a hint', async () => {
        const capture: { options?: any } = {};
        const runner = new AiSdkAgentRunner({
            resolve: () => capturingModel(capture) as any,
        } as ModelResolver<any>);

        await runner.run(
            baseSpec({ maxSteps: 4, systemProviderOptions: HINT }),
            { prompt: 'the task' },
            ctx,
        );

        // The lowered tools array carries the ephemeral marker (last tool).
        expect(hasCacheMarker(capture.options?.tools)).toBe(true);
        // The lowered prompt (messages) carries it on the user message.
        expect(hasCacheMarker(capture.options?.prompt)).toBe(true);
    });

    it('does NOT mark on a single-step run (cache write would not pay back)', async () => {
        const capture: { options?: any } = {};
        const runner = new AiSdkAgentRunner({
            resolve: () => capturingModel(capture) as any,
        } as ModelResolver<any>);

        await runner.run(
            baseSpec({ maxSteps: 1, systemProviderOptions: HINT }),
            { prompt: 'the task' },
            ctx,
        );

        expect(hasCacheMarker(capture.options?.tools)).toBe(false);
    });

    it('does NOT mark when the provider supplied no inline-cache hint', async () => {
        const capture: { options?: any } = {};
        const runner = new AiSdkAgentRunner({
            resolve: () => capturingModel(capture) as any,
        } as ModelResolver<any>);

        await runner.run(
            baseSpec({ maxSteps: 4, systemProviderOptions: undefined }),
            { prompt: 'the task' },
            ctx,
        );

        expect(hasCacheMarker(capture.options?.tools)).toBe(false);
    });
});
