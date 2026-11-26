/**
 * Compression against Anthropic's preserved-thinking check, through the real
 * runner. Review batches died with "Invalid `signature` in `thinking` block"
 * once compression shortened an earlier tool result (Nov 2026): the request
 * replayed thinking blocks whose prefix had changed.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { AgentTool, ToolContext } from '../../domain/contracts/tool.contract';
import { ContextWindowCompressor } from '../compression/context-window-compressor';
import { CompressionPolicy } from '../policies/compression.policy';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import {
    replayedSignatures,
    signedThinkingModel,
    thinkingContractViolations,
} from './__test-utils__/anthropic-thinking-contract';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const BIG = Array.from(
    { length: 1_600 },
    (_, i) => `const value${i} = compute(${i}, "path/to/file${i}.ts");`,
).join('\n');

const readFileTool: AgentTool = {
    name: 'readFile',
    description: 'read a file',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
    // The first read is small, so the thinking before it stays bound.
    execute: async (input: any) => ({
        output: input?.path === 'small.ts' ? 'export const ok = 1;' : BIG,
    }),
};

const doneTool: AgentTool = {
    name: 'submitResult',
    description: 'finalize',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'submitted' }),
};

const ctx: ToolContext = { runId: 'thinking-contract-e2e' };

function spec(): AgentSpec {
    return {
        id: 'generalist',
        systemPrompt: 'review the diff',
        tools: new InMemoryToolRegistry([readFileTool, doneTool]),
        policies: [new CompressionPolicy(new ContextWindowCompressor(20_000))],
        maxSteps: 20,
        resultToolName: 'submitResult',
    };
}

describe('AiSdkAgentRunner + compression — Anthropic thinking contract', () => {
    it('never replays a thinking block whose prefix compression changed', async () => {
        // Six reads: older results move from the recent cap to the older cap
        // as the run goes on, so the same message is cut differently over time.
        const { model, calls } = signedThinkingModel((turn) =>
            turn === 1
                ? { id: 'c1', name: 'readFile', input: { path: 'small.ts' } }
                : turn <= 6
                  ? { id: `c${turn}`, name: 'readFile', input: { path: `f${turn}.ts` } }
                  : { id: 'done', name: 'submitResult', input: {} },
        );
        (resolveModelConfig as jest.Mock).mockImplementation(() => ({
            model,
            callOptions: {},
            providerOptions: {},
            modelName: 'mock',
            usageIdentity: {},
        }));

        const state = await new AiSdkAgentRunner(undefined).run(spec(), { prompt: 'go' }, ctx);

        // Not vacuous: compression ran, and thinking was still replayed.
        expect(state.trace.some((e) => e.kind === 'context.compress')).toBe(true);
        expect(replayedSignatures(calls).flat()).toContain('sig-1');

        expect(thinkingContractViolations(calls)).toEqual([]);
    });
});
