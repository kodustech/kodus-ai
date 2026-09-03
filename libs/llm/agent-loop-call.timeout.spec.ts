/**
 * The agent loop must have a wall-clock floor under it.
 *
 * `AbortSignal` is the polite first try. Several OpenAI-compatible proxies
 * accept the connection, ignore the abort, and never answer — `llm-call.ts`
 * says so in as many words ("some providers ignore AbortSignal; this is the
 * safety net") and wraps the ONE-SHOT path in `hardTimeout` for exactly that.
 * The loop had no such net, and the loop is where reviews run.
 *
 * What that cost on 2026-09-03: a review's generalist agent stopped logging
 * mid-run. Nine pipeline stages reported `completed in Xms`; `AgentReviewStage`
 * reported nothing, ever. The PR kept the "review starting" comment the
 * pipeline had already posted, the sandbox lease stayed held, the span stayed
 * open, and nothing was logged as an error — a promise that never settles
 * throws nothing for a `catch` to see. The e2e gave up after its own 53-minute
 * budget, well past the 30-minute ceiling that was supposed to apply.
 *
 * These tests stub `generateText` to that exact shape — never settles, ignores
 * the signal. Without the wrapper they hang until jest kills them; with it they
 * reject as `[HARD-TIMEOUT]`.
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn(), stepCountIs: jest.fn((n: number) => ({ __stepCountIs: n })) };
});
jest.mock('@libs/llm/model-invocation', () => ({ resolveModelConfig: jest.fn() }));
jest.mock('@libs/llm/prompt-cache', () => ({ applyCacheBreakpoints: jest.fn() }));
jest.mock('@libs/llm/repair-tool-call', () => ({ repairInvalidToolInput: jest.fn() }));
jest.mock('@libs/llm/model-identity', () => ({ agentModelIdentity: jest.fn() }));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ experimental_telemetry: { isEnabled: false } })),
}));

import { generateText } from 'ai';
import { runAgentLoopCall } from '@libs/llm/agent-loop-call';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { applyCacheBreakpoints } from '@libs/llm/prompt-cache';
import { agentModelIdentity } from '@libs/llm/model-identity';

const mockGenerate = generateText as unknown as jest.Mock;
const mockResolve = resolveModelConfig as unknown as jest.Mock;
const mockCache = applyCacheBreakpoints as unknown as jest.Mock;
const mockIdentity = agentModelIdentity as unknown as jest.Mock;

const params = () =>
    ({
        messages: [{ role: 'user', content: 'review this' }],
        loop: { tools: {}, maxSteps: 1 },
        runName: 'agent.stalled',
        // Small so the test is fast; the wrapper adds a 5s grace on top.
        hardTimeoutMs: 40,
    }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue({
        model: { __model: 'main' },
        modelName: 'openai_compatible:stub',
        callOptions: {},
        providerOptions: {},
    });
    mockCache.mockImplementation((a: any) => ({
        systemArg: a?.system ? { system: a.system } : {},
        messages: a?.messages ?? [],
    }));
    mockIdentity.mockReturnValue({ byokModelId: 'stub', credentialId: 'cred' });
});

describe('runAgentLoopCall — a stalled provider must not hang the caller', () => {
    it('rejects on the wall clock when the provider never answers', async () => {
        mockGenerate.mockImplementation(() => new Promise(() => {}));

        await expect(runAgentLoopCall(params())).rejects.toThrow(/\[HARD-TIMEOUT\]/);
    });

    it('rejects even when handed an abort signal the provider ignores', async () => {
        mockGenerate.mockImplementation(
            (opts: any) =>
                new Promise(() => {
                    // Receiving the signal is not the same as honouring it: the
                    // stub takes it and still never settles, which is the whole
                    // failure mode.
                    void opts?.abortSignal;
                }),
        );

        await expect(runAgentLoopCall(params())).rejects.toThrow(/\[HARD-TIMEOUT\]/);
    });

    it('returns the result untouched when the provider answers in time', async () => {
        const result = { text: 'final answer', steps: [], usage: { totalTokens: 1 } };
        mockGenerate.mockResolvedValue(result);

        await expect(runAgentLoopCall(params())).resolves.toBe(result);
    });
});
