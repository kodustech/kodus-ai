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
 * own RunState. So the "output-shape zoo" (matrix A) and "semantic-but-wrong"
 * (matrix B) rows are asserted as the NON-DEGRADATION invariant of a pass-through:
 * WHATEVER shape generateText returns, the boundary returns the SAME reference,
 * unchanged, and never throws / coerces / drops. Value-encoding coercion and
 * envelope parsing belong to the downstream runner + the (separately-specced)
 * tool-call repair path; at THIS boundary the correct behavior for every odd
 * shape is verbatim pass-through with no silent transform.
 *
 * We do NOT test model DECISION quality (that is the eval track).
 *
 * See: /scratchpad/llm-io-contract-matrix.md (42 rows across A/B/C/D + E policy).
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
// A. Output-shape zoo (rows 1-18, 20) + B. Semantic-but-wrong (rows 21-27)
//
// This boundary declares its output D as "the raw generateText result". The
// non-degradation contract for a pass-through: return the EXACT reference for
// any shape, never transform / coerce / drop / crash. One parametrized suite
// pins that for the whole A/B zoo (row 19 + tool-arg recovery get their own
// delegation suite below; row 1 also gets the full happy-path assembly suite).
// ─────────────────────────────────────────────────────────────────────────────
describe('A/B pass-through — verbatim return for every output shape (rows 1-18, 20-27)', () => {
    const zoo: Array<[string, any]> = [
        ['row1 exact D (text/steps/usage)', OK_RESULT()],
        ['row2 bare array', [{ a: 1 }]],
        ['row3 single object where array expected', { one: true }],
        ['row4 wrapper key {result:D}', { result: { text: 'x' } }],
        ['row5 double wrapper {result:{result:D}}', { result: { result: {} } }],
        ['row6 opaque single-key {content:D}', { content: { text: 'x' } }],
        ['row7 stringified JSON', '{"text":"x"}'],
        ['row8 markdown-fenced', '```json\n{"text":"x"}\n```'],
        ['row9 prose-wrapped', 'Here is the result: {"text":"x"}'],
        ['row10 right data wrong keys', { output: 'x', tokens: 3 }],
        ['row11 case/convention mismatch', { Text: 'x', Steps: [] }],
        ['row12 partial object (missing keys)', { text: 'x' }],
        ['row13 extra unknown keys', { ...OK_RESULT(), surprise: 1 }],
        ['row14 empty object', {}],
        ['row15 empty array', []],
        ['row16 empty string', ''],
        ['row17 whitespace-only string', '   \n\t '],
        ['row18 primitive true', true],
        ['row18 primitive 0', 0],
        ['row18 primitive "ok"', 'ok'],
        [
            'row20 reasoning/thinking leak in content',
            { text: '<thinking>secret</thinking>answer', reasoning: 'r' },
        ],
        ['row21 boolean as string keep:"true"', { keep: 'true' }],
        ['row22 boolean as yes/no keep:"yes"', { keep: 'yes' }],
        ['row23 boolean as number keep:1', { keep: 1 }],
        ['row24 enum out of allowed set', { severity: 'URGENT' }],
        ['row25 index out of range / dangling ref', { unique: [999] }],
        ['row26 duplicate-keys JSON text (last wins)', '{"k":1,"k":2}'],
        ['row27 unicode/escapes/emoji in fields', { text: 'café\n🎉 ' }],
    ];

    it.each(zoo)(
        'returns the SAME reference unchanged, no throw: %s',
        async (_label, shape) => {
            mockGenerate.mockResolvedValueOnce(shape);
            const out = await runAgentLoopCall(baseParams());
            // Verbatim: identity for objects/arrays, value-equal for primitives.
            if (shape !== null && typeof shape === 'object') {
                expect(out).toBe(shape); // same reference — never re-wrapped/coerced
            } else {
                expect(out).toBe(shape);
            }
        },
    );

    it('row17 (null) — a null result passes through without a crash', async () => {
        mockGenerate.mockResolvedValueOnce(null as any);
        await expect(runAgentLoopCall(baseParams())).resolves.toBeNull();
    });

    it('row17 (undefined) — an undefined result passes through without a crash', async () => {
        mockGenerate.mockResolvedValueOnce(undefined as any);
        await expect(runAgentLoopCall(baseParams())).resolves.toBeUndefined();
    });

    it('does NOT coerce a semantic-wrong value (row21) — "true" stays the string "true"', async () => {
        const shape = { steps: [], text: '{"keep":"true"}', keep: 'true' };
        mockGenerate.mockResolvedValueOnce(shape);
        const out: any = await runAgentLoopCall(baseParams());
        expect(out.keep).toBe('true'); // still a string, not boolean true
        expect(out).toBe(shape);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Row 1 (exact D) — full happy-path REQUEST ASSEMBLY contract.
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
        expect(genArgs().stopWhen).toEqual([
            extraStop,
            { __stepCountIs: 12 },
        ]);
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
        (mockResolve() as any).model; // no-op keep types happy
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
        mockRepair.mockResolvedValueOnce({ toolName: 't1', input: '{"fixed":1}' });

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
// C. Unparseable / transport / fail-safe (rows 28-34)
//
// This boundary is the LOOP primitive: its fail-safe is SDK-level retry
// (maxRetries:3) plus EXPLICIT propagation to the caller — it never SWALLOWS an
// error into a silent default. A non-throwing odd result (empty / {error} /
// refusal / truncated) is returned verbatim; a thrown error re-throws (signals).
// ─────────────────────────────────────────────────────────────────────────────
describe('C fail-safe / transport (rows 28-34)', () => {
    it('row28 truncated result (finishReason:length) → returned verbatim, no crash', async () => {
        const truncated = {
            text: '{"partial":',
            finishReason: 'length',
            usage: {},
        };
        mockGenerate.mockResolvedValueOnce(truncated);
        await expect(runAgentLoopCall(baseParams())).resolves.toBe(truncated);
    });

    it('row29 malformed-JSON text → returned verbatim (parse is the runner/repair concern)', async () => {
        const malformed = { text: "{k: 'v',}", steps: [], usage: {} };
        mockGenerate.mockResolvedValueOnce(malformed);
        await expect(runAgentLoopCall(baseParams())).resolves.toBe(malformed);
    });

    it('row30 generateText THROWS (network) → propagates explicitly, never a silent default', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('fetch failed'));
        await expect(runAgentLoopCall(baseParams())).rejects.toThrow(
            'fetch failed',
        );
    });

    it('row30 the SDK owns retries — maxRetries:3 is pinned so the loop survives empty bodies', async () => {
        await runAgentLoopCall(baseParams());
        expect(genArgs().maxRetries).toBe(3);
    });

    it('row31 {error} result (resolved, not thrown) → returned verbatim, no crash', async () => {
        const errShape = { error: { message: 'provider 500' } };
        mockGenerate.mockResolvedValueOnce(errShape);
        await expect(runAgentLoopCall(baseParams())).resolves.toBe(errShape);
    });

    it('row32 empty success (text:"") → returned verbatim', async () => {
        const empty = { text: '', steps: [], usage: {}, finishReason: 'stop' };
        mockGenerate.mockResolvedValueOnce(empty);
        await expect(runAgentLoopCall(baseParams())).resolves.toBe(empty);
    });

    it('row33 refusal (finishReason:content_filter) → returned verbatim', async () => {
        const refusal = {
            text: 'I cannot help with that.',
            finishReason: 'content-filter',
            usage: {},
        };
        mockGenerate.mockResolvedValueOnce(refusal);
        await expect(runAgentLoopCall(baseParams())).resolves.toBe(refusal);
    });

    it('row34 abort signal is threaded to generateText (and the repair path)', async () => {
        const ctrl = new AbortController();
        await runAgentLoopCall({ ...baseParams(), signal: ctrl.signal });
        expect(genArgs().abortSignal).toBe(ctrl.signal);
    });

    it('row34 an AbortError from generateText propagates (never swallowed into a default)', async () => {
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        mockGenerate.mockRejectedValueOnce(abortErr);
        await expect(runAgentLoopCall(baseParams())).rejects.toThrow(
            'The operation was aborted',
        );
    });

    it('row30 the error propagates THROUGH the observability span too (span does not swallow)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('boom'));
        await expect(runAgentLoopCall(baseParams())).rejects.toThrow('boom');
        expect(spanPort.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Input variants (rows 35-42) — feed the boundary, assert the invariant.
// ─────────────────────────────────────────────────────────────────────────────
describe('D input variants (rows 35-42)', () => {
    it('row35 empty messages array → threaded whole (no synthetic message injected)', async () => {
        await runAgentLoopCall({ ...baseParams(), messages: [] as any });
        expect(genArgs().messages).toEqual([]);
        expect(mockCache.mock.calls[0][0].messages).toEqual([]);
    });

    it('row36 single message → threaded verbatim', async () => {
        const one = [{ role: 'user', content: 'only' }];
        await runAgentLoopCall({ ...baseParams(), messages: one as any });
        expect(genArgs().messages).toEqual(one);
    });

    it('row37 large message array (crosses no batch — boundary never chunks) → threaded whole', async () => {
        const big = Array.from({ length: 500 }, (_, i) => ({
            role: i % 2 ? 'assistant' : 'user',
            content: `m${i}`,
        }));
        await runAgentLoopCall({ ...baseParams(), messages: big as any });
        expect(genArgs().messages).toHaveLength(500);
        expect(genArgs().messages).toBe(big); // not sliced/copied/truncated
    });

    it('row38 duplicate messages → NOT de-duplicated at this layer', async () => {
        const dup = [
            { role: 'user', content: 'same' },
            { role: 'user', content: 'same' },
        ];
        await runAgentLoopCall({ ...baseParams(), messages: dup as any });
        expect(genArgs().messages).toHaveLength(2);
    });

    it('row39 null/undefined slot fields → managed path assembles cleanly (type:system)', async () => {
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

    it('row39 a message with a null content field → threaded verbatim, no crash', async () => {
        const withNull = [{ role: 'user', content: null }];
        await expect(
            runAgentLoopCall({ ...baseParams(), messages: withNull as any }),
        ).resolves.toBeDefined();
        expect(genArgs().messages).toEqual(withNull);
    });

    it('row40 special chars / whitespace-only system + diff → threaded verbatim', async () => {
        const weird = '  \n\t <script>💥</script>   ';
        await runAgentLoopCall({
            ...baseParams(),
            system: weird,
            messages: [{ role: 'user', content: '```\n\tdiff\r\n' }] as any,
        });
        expect(genArgs().system).toBe(weird);
        expect(genArgs().messages[0].content).toBe('```\n\tdiff\r\n');
    });

    it('row42 order permutation → the boundary preserves message order (no reordering)', async () => {
        const a = [
            { role: 'user', content: '1' },
            { role: 'assistant', content: '2' },
        ];
        const b = [
            { role: 'assistant', content: '2' },
            { role: 'user', content: '1' },
        ];
        await runAgentLoopCall({ ...baseParams(), messages: a as any });
        await runAgentLoopCall({ ...baseParams(), messages: b as any });
        // Deterministic threading: each call forwards its own order untouched.
        expect(genArgs(0).messages).toEqual(a);
        expect(genArgs(1).messages).toEqual(b);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observability span wrapping + span attributes (return-shape invariant across
// BOTH layers: with a port and without one).
// ─────────────────────────────────────────────────────────────────────────────
describe('observability span — present vs absent port', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// E. Provider / model matrix. The agent loop has NO structured-output channel,
// so the json_schema-vs-json_object policy gate (structured-output-gate.ts) does
// NOT participate here — model policy is delegated to the resolver + tool-repair.
// What this boundary IS provider-aware about: the cache hint (keyed off the
// slot's provider/model) and the span type. So we run the pass-through zoo under
// BOTH a strict-json_schema family (anthropic) and a json_object-fallback family
// (moonshot/kimi) and assert IDENTICAL verbatim behavior + correct provider
// threading — proving the loop is model-policy-agnostic (no degradation either way).
// ─────────────────────────────────────────────────────────────────────────────
describe('E provider matrix — pass-through is identical across policy families', () => {
    const providers: Array<[string, string]> = [
        ['strict json_schema family', 'anthropic'],
        ['strict json_schema family', 'openai'],
        ['strict json_schema family', 'google'],
        ['json_object fallback family', 'moonshot'], // kimi transport
        ['json_object fallback family', 'z_ai'], // glm transport
        ['json_object fallback family', 'deepseek'],
    ];

    it.each(providers)(
        'threads the slot provider/model into the cache hint (%s: %s)',
        async (_family, provider) => {
            await runAgentLoopCall({
                ...baseParams(),
                byokConfig: { provider, model: `${provider}-model` } as any,
            });
            expect(mockCache.mock.calls[0][0].provider).toBe(provider);
            expect(mockCache.mock.calls[0][0].model).toBe(`${provider}-model`);
        },
    );

    it.each(providers)(
        'returns an off-schema result verbatim regardless of family (%s: %s)',
        async (_family, provider) => {
            const offSchema = { result: { nested: 'x' }, notD: true };
            mockGenerate.mockResolvedValueOnce(offSchema);
            const out = await runAgentLoopCall({
                ...baseParams(),
                byokConfig: { provider, model: 'm' } as any,
            });
            // No family parses/repairs the loop result here — always verbatim.
            expect(out).toBe(offSchema);
        },
    );
});
