/**
 * CONTRACT tests for the `runAgentLoopCall` LLM.run boundary (agent-loop-call.ts)
 * — the LOOP half of `LLM.run` (the AI SDK `generateText` + tools + stopWhen).
 *
 * SCOPE = the DETERMINISTIC layer only:
 *   - request assembly: exact args / system / messages / tools / tuning /
 *     providerOptions / abortSignal / stopWhen / repair / telemetry
 *   - byokConfig (slot) threading into resolveModelConfig + applyCacheBreakpoints
 *   - the tool-call self-heal delegation (repairToolCall → repairInvalidToolInput)
 *   - the observability span wrapping (present vs absent port)
 *   - the GUARANTEED return shape: the raw generateText result, verbatim
 *
 * This boundary is a PASS-THROUGH: it never parses/validates the model output —
 * it returns the raw `generateText` result to the runner, which maps it onto its
 * own RunState. One case pins that return reference; envelope parsing belongs to
 * the downstream runner + the (separately-specced) tool-call repair path.
 *
 * We do NOT test model DECISION quality (that is the eval track).
 */

// ── Mock the LLM.run boundary itself: `generateText` from the AI SDK. ──
// stepCountIs returns a sentinel so we can assert the stopWhen composition.
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return {
        ...actual,
        generateText: jest.fn(),
        stepCountIs: jest.fn((n: number) => ({ __stepCountIs: n })),
    };
});

// ── Mock every @libs dependency so no real model/network/DI is touched. ──
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));
jest.mock('@libs/llm/prompt-cache', () => ({
    applyCacheBreakpoints: jest.fn(),
}));
jest.mock('@libs/llm/repair-tool-call', () => ({
    repairInvalidToolInput: jest.fn(),
}));
jest.mock('@libs/llm/model-identity', () => ({
    agentModelIdentity: jest.fn(),
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({
        experimental_telemetry: { isEnabled: false },
    })),
}));

import { generateText, stepCountIs } from 'ai';
import { runAgentLoopCall } from '@libs/llm/agent-loop-call';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { applyCacheBreakpoints } from '@libs/llm/prompt-cache';
import { repairInvalidToolInput } from '@libs/llm/repair-tool-call';
import { agentModelIdentity } from '@libs/llm/model-identity';
import {
    setLlmObservability,
    getLlmObservability,
} from '@libs/llm/llm-observability';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';

const mockGenerate = generateText as unknown as jest.Mock;
const mockStepCountIs = stepCountIs as unknown as jest.Mock;
const mockResolve = resolveModelConfig as unknown as jest.Mock;
const mockCache = applyCacheBreakpoints as unknown as jest.Mock;
const mockRepair = repairInvalidToolInput as unknown as jest.Mock;
const mockIdentity = agentModelIdentity as unknown as jest.Mock;

// A span port that just runs the exec (records nothing) — lets us assert the
// boundary routes through the span AND still returns the exec's result verbatim.
let spanPort: { runAiSdkLLMInSpan: jest.Mock };

const RESOLVED_MODEL = { __model: 'main' };

const defaultResolved = () => ({
    model: RESOLVED_MODEL,
    modelName: 'openai:gpt-x',
    callOptions: {} as { temperature?: number; maxOutputTokens?: number },
    providerOptions: { __po: 'slot' },
});

/** The canonical LOOP result the model returns (steps / usage / text). */
const OK_RESULT = () => ({
    text: 'final answer',
    steps: [{ toolCalls: [] }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    finishReason: 'stop',
});

const baseParams = () => ({
    messages: [{ role: 'user', content: 'review this' }] as any,
    loop: { tools: { t1: { description: 'd' } }, maxSteps: 8 } as any,
    runName: 'agent.run',
});

const genArgs = (i = 0) => mockGenerate.mock.calls[i][0];

beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockReturnValue(defaultResolved());
    // applyCacheBreakpoints identity by default: inputs pass through untouched.
    mockCache.mockImplementation(({ system, messages, tools }: any) => ({
        systemArg: system,
        callMessages: messages,
        callTools: tools,
    }));
    mockIdentity.mockReturnValue({
        model: 'openai:gpt-x',
        isByok: true,
        byokModelId: 'bm-1',
        credentialId: 'cred-1',
    });
    mockStepCountIs.mockImplementation((n: number) => ({ __stepCountIs: n }));
    mockGenerate.mockResolvedValue(OK_RESULT());
    spanPort = {
        runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    };
    setLlmObservability(spanPort as any);
});

afterEach(() => {
    // RESTORE the port so a parity test in another file never inherits it.
    setLlmObservability(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Full happy-path REQUEST ASSEMBLY contract.
// ─────────────────────────────────────────────────────────────────────────────
describe('row1 request assembly — the exact generateText invocation', () => {
    it('threads model, retries, system, messages, tools, providerOptions, signal', async () => {
        const signal = new AbortController().signal;
        await runAgentLoopCall({
            ...baseParams(),
            system: 'sys',
            signal,
        });

        const args = genArgs();
        expect(args.model).toBe(RESOLVED_MODEL);
        expect(args.maxRetries).toBe(3); // AGENT_STEP_MAX_RETRIES
        expect(args.system).toBe('sys'); // from applyCacheBreakpoints (identity)
        expect(args.messages).toEqual([
            { role: 'user', content: 'review this' },
        ]);
        expect(args.tools).toEqual({ t1: { description: 'd' } });
        expect(args.providerOptions).toEqual({ __po: 'slot' }); // slot-derived
        expect(args.abortSignal).toBe(signal);
    });

    it('composes stopWhen = [...loop.stopWhen, stepCountIs(maxSteps)]', async () => {
        const extraStop = { __policyStop: true };
        await runAgentLoopCall({
            ...baseParams(),
            loop: {
                tools: {},
                maxSteps: 12,
                stopWhen: [extraStop],
            } as any,
        });

        expect(mockStepCountIs).toHaveBeenCalledWith(12);
        expect(genArgs().stopWhen).toEqual([extraStop, { __stepCountIs: 12 }]);
    });

    it('appends only the step ceiling when the runner supplies no stopWhen', async () => {
        await runAgentLoopCall(baseParams());
        expect(genArgs().stopWhen).toEqual([{ __stepCountIs: 8 }]);
    });

    it('resolves the model through resolveModelConfig with the slot + routing opts', async () => {
        const reporter = jest.fn();
        await runAgentLoopCall({
            ...baseParams(),
            byokConfig: {
                provider: 'openai',
                model: 'gpt-x',
                openrouterProviderOrder: ['a', 'b'],
                openrouterAllowFallbacks: false,
            } as any,
            organizationId: 'org-9',
            reporter,
            provider: 'openai',
            queueTimeoutMs: 45_000,
        });

        expect(mockResolve).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'openai', model: 'gpt-x' }),
            expect.objectContaining({
                runName: 'agent.run',
                organizationId: 'org-9',
                reporter,
                provider: 'openai',
                queueTimeoutMs: 45_000,
                openrouterProviderOrder: ['a', 'b'],
                openrouterAllowFallbacks: false,
            }),
        );
    });

    it('passes system/messages/tools + slot provider+model into applyCacheBreakpoints', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            system: 'S',
            byokConfig: { provider: 'anthropic', model: 'claude' } as any,
        });
        expect(mockCache).toHaveBeenCalledWith({
            system: 'S',
            messages: [{ role: 'user', content: 'review this' }],
            tools: { t1: { description: 'd' } },
            maxSteps: 8,
            provider: 'anthropic',
            model: 'claude',
        });
    });

    it('falls back to the resolved model name for the cache hint when no slot (managed default)', async () => {
        mockResolve.mockReturnValue({
            ...defaultResolved(),
            model: RESOLVED_MODEL,
        });
        await runAgentLoopCall(baseParams()); // no byokConfig
        const cacheArg = mockCache.mock.calls[0][0];
        expect(cacheArg.provider).toBeUndefined(); // slot?.provider
        expect(cacheArg.model).toBe(RESOLVED_MODEL); // slot?.model ?? inv.model
    });

    it('returns exactly the generateText result reference (declared return shape)', async () => {
        const result = OK_RESULT();
        mockGenerate.mockResolvedValueOnce(result);
        const out = await runAgentLoopCall(baseParams());
        expect(out).toBe(result);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tuning threading — temperature / maxOutputTokens omission contract.
// ─────────────────────────────────────────────────────────────────────────────
describe('tuning threading — temperature + maxOutputTokens', () => {
    it('caller temperature overrides the slot; slot maxOutputTokens wins over the fallback', async () => {
        mockResolve.mockReturnValue({
            ...defaultResolved(),
            callOptions: { temperature: 0.2, maxOutputTokens: 4096 },
        });
        await runAgentLoopCall({
            ...baseParams(),
            temperature: 0.9, // caller override
            maxOutputTokens: 100, // fallback only (slot sets 4096)
        });
        expect(genArgs().temperature).toBe(0.9);
        expect(genArgs().maxOutputTokens).toBe(4096);
    });

    it('uses the slot temperature and the fallback maxOutputTokens when the caller omits them', async () => {
        mockResolve.mockReturnValue({
            ...defaultResolved(),
            callOptions: { temperature: 0.3 }, // no maxOutputTokens
        });
        await runAgentLoopCall({ ...baseParams(), maxOutputTokens: 7777 });
        expect(genArgs().temperature).toBe(0.3);
        expect(genArgs().maxOutputTokens).toBe(7777);
    });

    it('OMITS temperature and maxOutputTokens entirely when neither slot nor caller set them', async () => {
        mockResolve.mockReturnValue({
            ...defaultResolved(),
            callOptions: {},
        });
        await runAgentLoopCall(baseParams());
        expect(genArgs()).not.toHaveProperty('temperature');
        expect(genArgs()).not.toHaveProperty('maxOutputTokens');
    });

    it('a caller providerOptions override wins over the slot-derived ones', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            providerOptions: { __po: 'caller-override' },
        });
        expect(genArgs().providerOptions).toEqual({ __po: 'caller-override' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Row 19 (provider envelope leak / tool_call arguments-as-string) + tool-call
// self-heal: the boundary DELEGATES tool-input recovery to repairInvalidToolInput
// against THIS resolved model, threading the abort signal.
// ─────────────────────────────────────────────────────────────────────────────
describe('row19 tool-call repair delegation (repairToolCall → repairInvalidToolInput)', () => {
    it('wires a repairToolCall seam onto the generateText call', async () => {
        await runAgentLoopCall(baseParams());
        expect(typeof genArgs().repairToolCall).toBe('function');
    });

    it('delegates to repairInvalidToolInput with THIS model + abort signal + the failed toolCall', async () => {
        const signal = new AbortController().signal;
        mockRepair.mockResolvedValueOnce({
            toolName: 't1',
            input: '{"fixed":1}',
        });

        await runAgentLoopCall({ ...baseParams(), signal });

        const repairFn = genArgs().repairToolCall as Function;
        const toolCall = { toolName: 't1', input: 'not-json-args' };
        const inputSchema = jest.fn();
        const error = new Error('args failed schema');
        const recovered = await repairFn({ toolCall, inputSchema, error });

        expect(mockRepair).toHaveBeenCalledWith({
            model: RESOLVED_MODEL, // re-issues against the resolved model, not a system one
            abortSignal: signal,
            toolCall,
            inputSchema,
            error,
            // The re-ask runs in a usage span of its own (charged to the org).
            inSpan: expect.any(Function),
            logContext: expect.any(Object),
        });
        expect(recovered).toEqual({ toolName: 't1', input: '{"fixed":1}' });
    });

    it('propagates the repair fail-soft result (null = SDK default "let the step fail")', async () => {
        mockRepair.mockResolvedValueOnce(null);
        await runAgentLoopCall(baseParams());
        const repairFn = genArgs().repairToolCall as Function;
        await expect(
            repairFn({
                toolCall: { toolName: 'x', input: 1 },
                inputSchema: jest.fn(),
                error: new Error('e'),
            }),
        ).resolves.toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observability span wrapping + span attributes (return-shape invariant across
// BOTH layers: with a port and without one).
// ─────────────────────────────────────────────────────────────────────────────
describe('observability span — present vs absent port', () => {
    it('a thrown error propagates THROUGH the observability span too (span does not swallow)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('boom'));
        await expect(runAgentLoopCall(baseParams())).rejects.toThrow('boom');
        expect(spanPort.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
    });

    it('no slot (managed path) → span type system, ids undefined', async () => {
        mockIdentity.mockReturnValue({
            model: 'managed-default',
            isByok: false,
            byokModelId: undefined,
            credentialId: undefined,
        });
        await runAgentLoopCall({ ...baseParams(), byokConfig: undefined });
        // no slot → span type is 'system', ids undefined, no crash
        const spanArg = spanPort.runAiSdkLLMInSpan.mock.calls[0][0];
        expect(spanArg.attrs.type).toBe('system');
        expect(spanArg.byokModelId).toBeUndefined();
        expect(spanArg.credentialId).toBeUndefined();
    });

    it('routes through the span and returns the exec result verbatim', async () => {
        const result = OK_RESULT();
        mockGenerate.mockResolvedValueOnce(result);
        const out = await runAgentLoopCall(baseParams());
        expect(spanPort.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(out).toBe(result);
    });

    it('bare caller (no port registered) → runs directly, no span, still returns verbatim', async () => {
        setLlmObservability(undefined);
        expect(getLlmObservability()).toBeUndefined();
        const result = OK_RESULT();
        mockGenerate.mockResolvedValueOnce(result);
        const out = await runAgentLoopCall(baseParams());
        expect(out).toBe(result);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('stamps span identity: modelName, byokModelId, credentialId, route, usedFallback', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            byokConfig: {
                provider: 'openai',
                model: 'gpt-x',
                route: 'codeReview',
                usedFallback: true,
            } as any,
            spanName: 'finder.span',
        });
        const arg = spanPort.runAiSdkLLMInSpan.mock.calls[0][0];
        expect(arg.spanName).toBe('finder.span'); // spanName ?? runName
        expect(arg.runName).toBe('agent.run');
        expect(arg.model).toBe('openai:gpt-x'); // inv.modelName
        expect(arg.byokModelId).toBe('bm-1');
        expect(arg.credentialId).toBe('cred-1');
        expect(arg.route).toBe('codeReview');
        expect(arg.usedFallback).toBe(true);
    });

    // The span opens a Langfuse observation only for a traced call; the flag
    // must follow the same condition that turns the SDK telemetry on.
    it('marks the span traced only when telemetry metadata is set', async () => {
        await runAgentLoopCall(baseParams());
        await runAgentLoopCall({
            ...baseParams(),
            telemetryMetadata: { organizationId: 'org-1' },
        });
        expect(spanPort.runAiSdkLLMInSpan.mock.calls[0][0].traced).toBe(false);
        expect(spanPort.runAiSdkLLMInSpan.mock.calls[1][0].traced).toBe(true);
    });

    it('span name defaults to runName when spanName is unset', async () => {
        await runAgentLoopCall(baseParams());
        expect(spanPort.runAiSdkLLMInSpan.mock.calls[0][0].spanName).toBe(
            'agent.run',
        );
    });

    it('span attrs.type = "byok" for a slot, and merges caller attrs + organizationId', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            byokConfig: { provider: 'openai', model: 'gpt-x' } as any,
            organizationId: 'org-7',
            attrs: { agentName: 'finder', phase: 'analyze' },
        });
        const attrs = spanPort.runAiSdkLLMInSpan.mock.calls[0][0].attrs;
        expect(attrs.type).toBe('byok');
        expect(attrs.agentName).toBe('finder');
        expect(attrs.phase).toBe('analyze');
        expect(attrs.organizationId).toBe('org-7');
    });

    it('a caller-supplied attrs.type overrides the slot-derived default', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            byokConfig: { provider: 'openai' } as any,
            attrs: { type: 'custom-type' },
        });
        expect(spanPort.runAiSdkLLMInSpan.mock.calls[0][0].attrs.type).toBe(
            'custom-type',
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry wiring — only present when telemetryMetadata is supplied.
// ─────────────────────────────────────────────────────────────────────────────
describe('langfuse telemetry — conditional wiring', () => {
    it('omits telemetry args entirely when no telemetryMetadata is given', async () => {
        await runAgentLoopCall(baseParams());
        expect(buildLangfuseTelemetry).not.toHaveBeenCalled();
        expect(genArgs()).not.toHaveProperty('experimental_telemetry');
    });

    it('builds + spreads telemetry args when telemetryMetadata is present', async () => {
        await runAgentLoopCall({
            ...baseParams(),
            telemetryMetadata: { sessionId: 's1' } as any,
        });
        expect(buildLangfuseTelemetry).toHaveBeenCalledWith('agent.run', {
            sessionId: 's1',
        });
        expect(toAiSdkTelemetryArgs).toHaveBeenCalled();
        expect(genArgs().experimental_telemetry).toEqual({ isEnabled: false });
    });
});
