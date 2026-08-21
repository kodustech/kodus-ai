/**
 * AiSdkAgentRunner END-TO-END test with a MOCKED model (ai/test).
 *
 * This is the capstone: it proves the new harness ACTUALLY EXECUTES a
 * multi-step tool loop with composed policies and produces a RunState —
 * deterministically, no real LLM. The model is scripted to call a tool, then
 * finalize; the CompletionGatePolicy stops the loop; the BudgetPolicy composes
 * alongside. Asserts the loop drove the tool and recorded the run.
 */
// The runner drives the loop through LLM.run, which resolves the model via
// resolveModelConfig — mock it to inject the scripted MockLanguageModelV3.
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV3 } from 'ai/test';

import { scriptedToolModel } from './__test-utils__/scripted-tool-model';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ProgressLedger } from '../../domain/contracts/progress.contract';
import type { ToolContext, AgentTool } from '../../domain/contracts/tool.contract';
import { BudgetPolicy } from '../policies/budget.policy';
import { CompletionGatePolicy } from '../policies/completion-gate.policy';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

// --- a scripted model: step 0 -> call echo; step 1 -> call submitResult ---
function scriptedModel() {
    return scriptedToolModel((turn) =>
        turn === 1
            ? { id: 'c1', name: 'echo', input: { text: 'hello' } }
            : { id: 'c2', name: 'submitResult', input: { findings: [] } },
    );
}

const mockResolve = resolveModelConfig as jest.Mock;

/** Point the mocked resolution at a given model (fresh per run). */
function wireModel(model: any) {
    mockResolve.mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
}

const echoTool: AgentTool = {
    name: 'echo',
    description: 'echo the input',
    inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    execute: async (input: any) => ({ output: `echo:${input.text}` }),
};

const doneTool: AgentTool = {
    name: 'submitResult',
    description: 'finalize',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'submitted' }),
};

function noCriticalLedger(): ProgressLedger {
    return {
        markFromToolCall: () => undefined,
        summary: () => ({
            totalTargets: 0,
            pendingTargets: 0,
            criticalTotal: 0,
            criticalPending: 0,
        }),
        debtNote: () => null,
    };
}

const ctx: ToolContext = { runId: 'e2e-1' };

describe('AiSdkAgentRunner (end-to-end, mocked model)', () => {
    it('drives a multi-step tool loop, applies policies, and returns a RunState', async () => {
        const spec: AgentSpec = {
            id: 'finder',
            systemPrompt: 'find bugs',
            tools: new InMemoryToolRegistry([echoTool, doneTool]),
            policies: [
                new BudgetPolicy(),
                new CompletionGatePolicy(noCriticalLedger(), {
                    doneToolName: 'submitResult',
                }),
            ],
            maxSteps: 10,
            resultToolName: 'submitResult',
        };

        wireModel(scriptedModel());
        const runner = new AiSdkAgentRunner(undefined);
        const state = await runner.run(spec, { prompt: 'go' }, ctx);

        // the loop executed multiple steps (echo, then submitResult)
        expect(state.steps.length).toBeGreaterThanOrEqual(2);
        // it stopped via the coverage policy honoring the done tool
        expect(state.stopReason).toBe('completion-gate');
        expect(state.status).toBe('stopped');
        // the run is observable
        expect(state.runId).toBe('e2e-1');
        expect(state.agentId).toBe('finder');
        // the "result tool" convention materialized the final tool call into
        // artifacts — the domain reads this, never re-scans steps by hand.
        expect(state.artifacts).toHaveLength(1);
        expect(state.artifacts[0]).toMatchObject({
            type: 'submitResult',
            stage: 'completion-gate',
            payload: { findings: [] },
        });
    });

    it('turns a model/provider throw into a RunState{status:error}, not an exception', async () => {
        wireModel(
            new MockLanguageModelV3({
                doGenerate: (async () => {
                    throw new Error('boom: provider rejected request');
                }) as any,
            }),
        );
        const spec: AgentSpec = {
            id: 'finder',
            systemPrompt: 'find bugs',
            tools: new InMemoryToolRegistry([echoTool, doneTool]),
            policies: [
                new CompletionGatePolicy(noCriticalLedger(), {
                    doneToolName: 'submitResult',
                }),
            ],
            maxSteps: 10,
        };

        const runner = new AiSdkAgentRunner(undefined);

        // MUST NOT throw — the failure is captured into the RunState.
        const state = await runner.run(spec, { prompt: 'go' }, ctx);

        expect(state.status).toBe('error');
        expect(state.stopReason).toBe('error');
        // the failure is observable in the trace, not lost to a stack trace
        const errEvent = state.trace.find((e) => e.kind === 'error');
        expect(errEvent).toBeDefined();
        expect(String(errEvent?.detail?.message)).toContain('boom');
    });

    it('emits a tool.skipped trace event when a tool call ends on an unsafe finish reason', async () => {
        // The model requests a tool but the turn ends TRUNCATED (finishReason
        // 'length'): ai@7.0.70+ refuses to auto-execute the tool. The runner must
        // make that visible in the trace instead of silently returning a short,
        // empty run — the diagnostic we need for a BYOK provider that truncates.
        wireModel(
            new MockLanguageModelV3({
                doGenerate: (async () => ({
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'c1',
                            toolName: 'echo',
                            input: JSON.stringify({ text: 'hi' }),
                        },
                    ],
                    finishReason: { unified: 'length', raw: 'length' },
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
                })) as any,
            }),
        );
        const spec: AgentSpec = {
            id: 'finder',
            systemPrompt: 'find bugs',
            tools: new InMemoryToolRegistry([echoTool, doneTool]),
            policies: [
                new CompletionGatePolicy(noCriticalLedger(), {
                    doneToolName: 'submitResult',
                }),
            ],
            maxSteps: 10,
            resultToolName: 'submitResult',
        };

        const runner = new AiSdkAgentRunner(undefined);
        const state = await runner.run(spec, { prompt: 'go' }, ctx);

        const skipped = state.trace.find((e) => e.kind === 'tool.skipped');
        expect(skipped).toBeDefined();
        expect(skipped?.detail?.finishReason).toBe('length');
        expect(skipped?.detail?.tools).toEqual(['echo']);
        // the tool never ran, so nothing was finalized into artifacts.
        expect(state.artifacts).toHaveLength(0);
    });
});
