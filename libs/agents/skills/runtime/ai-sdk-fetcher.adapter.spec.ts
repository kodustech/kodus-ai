/**
 * CONTRACT tests for the skills-engine LLM.run boundary
 * (`ai-sdk-fetcher.adapter.ts`).
 *
 * The `LLM.run` call itself lives one layer down, inside `AiSdkAgentRunner.run`
 * — this adapter DELEGATES the model call and never parses the model's JSON. Its
 * deterministic surface, and the whole scope of these tests, is:
 *
 *   1. REQUEST ASSEMBLY  — how `runMcpFetcherAgent` threads byokConfig / prompt
 *      / systemPrompt / tools / telemetry / signal / maxSteps / compression
 *      into `new AiSdkAgentRunner(slot, opts)` + `runner.run(spec, input, ctx)`.
 *   2. ENVELOPE PARSING  — how `extractFinalText` turns a `RunState` envelope
 *      into the returned `text` (text-passthrough, whitespace/empty/primitive
 *      handling, backward scan).
 *   3. FALLBACK          — the reactive context-overflow re-run at 60%.
 *   4. RETURN SHAPE      — the boundary ALWAYS returns `FetcherRunResult`
 *      ({text, state, usage} with computed totalTokens).
 *   5. TOOL WRAPPING     — `buildMcpAgentToolRegistry` (fail-safe {isError} tool
 *      execution, serialization, defaults, dedup, order-invariance).
 *
 * The I/O contract matrix (llm-io-contract-matrix.md) is closed against THIS
 * boundary. Many A/B/C rows are N/A here BY DESIGN: this boundary does not parse
 * the model's structured JSON (it returns raw text for the caller's capability
 * to parse), so wrapper-key/wrong-key/malformed-JSON/value-encoding rows have no
 * parse layer to degrade. They are recorded in rowsNA. The rows that DO apply —
 * text passthrough (no silent unwrap), envelope emptiness, fail-safe on throw,
 * overflow fallback, and every input variant — are asserted explicitly.
 *
 * The `AiSdkAgentRunner` module is mocked so we control the RunState envelope
 * and capture the constructor + run() arguments. `isContextOverflowResult` is
 * mocked to drive the fallback branch deterministically. Real CompressionPolicy
 * / ContextWindowCompressor are used so `spec.policies` is asserted by type.
 */

import type {
    RunState,
    RunStep,
    TokenUsage,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';

import {
    buildMcpAgentToolRegistry,
    runMcpFetcherAgent,
} from './ai-sdk-fetcher.adapter';

// --- mock: AiSdkAgentRunner (the LLM.run boundary one layer down) ----------
const mockRunFn = jest.fn();
const mockCtorCalls: unknown[][] = [];
jest.mock(
    '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner',
    () => ({
        AiSdkAgentRunner: jest
            .fn()
            .mockImplementation((...args: unknown[]) => {
                mockCtorCalls.push(args);
                return { run: mockRunFn };
            }),
    }),
);

// --- mock: reactive overflow detector (drives the fallback branch) ---------
const mockIsOverflow = jest.fn().mockReturnValue(false);
jest.mock('@libs/llm/context-overflow', () => ({
    isContextOverflowResult: (...a: unknown[]) => mockIsOverflow(...a),
    runStateErrorText: jest.fn().mockReturnValue(''),
}));

// --- helpers ---------------------------------------------------------------
function makeState(overrides: Partial<RunState> = {}): RunState {
    return {
        runId: 'run-1',
        agentId: 'agent-1',
        status: 'completed',
        steps: [],
        artifacts: [],
        usage: {},
        trace: [],
        ...overrides,
    } as RunState;
}

/** Build a RunState whose steps carry the given `content` values (one per step,
 *  in order) as assistant messages. */
function stateWithContents(contents: unknown[]): RunState {
    const steps: RunStep[] = contents.map((content, index) => ({
        index,
        message: { role: 'assistant', content: content as never },
    }));
    return makeState({ steps });
}

const baseParams = () => ({
    byokConfig: undefined,
    agentId: 'fetcher-agent',
    systemPrompt: 'SYSTEM',
    prompt: 'USER',
    tools: {
        get: () => undefined,
        list: () => [],
    } as ToolRegistry,
    maxSteps: 12,
    runId: 'run-xyz',
});

/** Minimal fake MCPAdapter for buildMcpAgentToolRegistry. */
function fakeAdapter(opts: {
    getTools: unknown[];
    executeTool?: (name: string, args: unknown) => unknown;
}): any {
    return {
        getTools: async () => opts.getTools,
        executeTool: opts.executeTool
            ? jest.fn(async (name: string, args: unknown) =>
                  opts.executeTool!(name, args),
              )
            : jest.fn(async () => 'OK'),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCtorCalls.length = 0;
    mockIsOverflow.mockReturnValue(false);
    mockRunFn.mockResolvedValue(stateWithContents(['DEFAULT']));
});

// =========================================================================
// runMcpFetcherAgent — request assembly (D / abort / N-model threading)
// =========================================================================
describe('runMcpFetcherAgent — request assembly', () => {
    it('[Row 1] threads spec/input/ctx exactly into runner.run', async () => {
        const params = {
            ...baseParams(),
            signal: new AbortController().signal,
            telemetry: {
                functionId: 'fn-42',
                organizationId: 'org-1',
                teamId: 'team-1',
                provider: 'openai',
            },
        };

        await runMcpFetcherAgent(params);

        expect(mockRunFn).toHaveBeenCalledTimes(1);
        const [spec, input, ctx] = mockRunFn.mock.calls[0];
        expect(spec.id).toBe('fetcher-agent');
        expect(spec.agentName).toBe('fetcher-agent');
        expect(spec.runName).toBe('fn-42'); // telemetry.functionId wins
        expect(spec.systemPrompt).toBe('SYSTEM');
        expect(spec.tools).toBe(params.tools); // same ref, no copy
        expect(spec.maxSteps).toBe(12);
        expect(input.prompt).toBe('USER');
        expect(input.telemetryMetadata).toEqual({
            organizationId: 'org-1',
            teamId: 'team-1',
            provider: 'openai',
        });
        expect(ctx.runId).toBe('run-xyz');
        expect(ctx.signal).toBe(params.signal);
    });

    it('[Row 1/E] threads byokConfig slot + org/reporter into the runner ctor', async () => {
        const reporter = jest.fn();
        const slot = { provider: 'moonshotai', model: 'kimi-k2' } as any;

        await runMcpFetcherAgent({
            ...baseParams(),
            byokConfig: slot,
            reporter,
            telemetry: { functionId: 'fn', organizationId: 'org-9' },
        });

        expect(mockCtorCalls).toHaveLength(1);
        const [slotArg, opts] = mockCtorCalls[0];
        expect(slotArg).toBe(slot);
        expect(opts).toEqual({ organizationId: 'org-9', reporter });
    });

    it('[Row 35] runName falls back to agentId when telemetry absent, and no telemetryMetadata key is added', async () => {
        await runMcpFetcherAgent(baseParams());

        const [spec, input] = mockRunFn.mock.calls[0];
        expect(spec.runName).toBe('fetcher-agent');
        expect('telemetryMetadata' in input).toBe(false);
        // ctor still receives an opts object (org undefined, no reporter)
        expect(mockCtorCalls[0][1]).toEqual({
            organizationId: undefined,
            reporter: undefined,
        });
    });

    it('[Row 34] threads an already-aborted signal verbatim (no pre-check swallow)', async () => {
        const ac = new AbortController();
        ac.abort();
        await runMcpFetcherAgent({ ...baseParams(), signal: ac.signal });

        const ctx = mockRunFn.mock.calls[0][2];
        expect(ctx.signal).toBe(ac.signal);
        expect(ctx.signal.aborted).toBe(true);
    });

    it('[Row 37] adds a CompressionPolicy only when contextWindowTokens is set', async () => {
        await runMcpFetcherAgent({
            ...baseParams(),
            contextWindowTokens: 100_000,
        });
        const specWith = mockRunFn.mock.calls[0][0];
        expect(specWith.policies).toHaveLength(1);
        expect(specWith.policies[0]).toBeInstanceOf(CompressionPolicy);

        mockRunFn.mockClear();
        await runMcpFetcherAgent(baseParams());
        const specWithout = mockRunFn.mock.calls[0][0];
        expect(specWithout.policies).toEqual([]);
    });

    it('[Row 40] threads a special-char / whitespace prompt verbatim', async () => {
        const prompt = '   \n\t {"weird": "→ ✅ \\n emoji 😀"} <script>   ';
        await runMcpFetcherAgent({ ...baseParams(), prompt });
        expect(mockRunFn.mock.calls[0][1].prompt).toBe(prompt);
    });
});

// =========================================================================
// runMcpFetcherAgent — envelope parsing (extractFinalText) + return shape
// =========================================================================
describe('runMcpFetcherAgent — envelope parsing / return shape', () => {
    it('[Row 1] returns the last non-empty assistant text and exact usage', async () => {
        const usage: TokenUsage = {
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 3,
        };
        const state = makeState({
            steps: [
                { index: 0, message: { role: 'assistant', content: 'first' } },
                { index: 1, message: { role: 'assistant', content: 'FINAL' } },
            ],
            usage,
        });
        mockRunFn.mockResolvedValue(state);

        const res = await runMcpFetcherAgent(baseParams());
        expect(res.text).toBe('FINAL');
        expect(res.state).toBe(state); // full state passed through for billing
        expect(res.usage).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            reasoningTokens: 3,
        });
    });

    it('[Rows 4-9] text is PASSTHROUGH — the boundary never unwraps or parses model output', async () => {
        // wrapper-key(4) / double(5) / numeric-wrap(6) / stringified(7) /
        // fenced(8) / prose(9): each returned VERBATIM, never unwrapped. Parsing
        // is the caller's capability layer, not this boundary.
        const shapes = [
            '{"result":{"groups":[]}}',
            '{"result":{"result":{"keep":true}}}',
            '{"0":{"keep":true}}',
            '"{\\"keep\\":true}"',
            '```json\n{"keep":true}\n```',
            'Here is the result: {"keep":true}\n\nLet me know!',
        ];
        for (const shape of shapes) {
            mockRunFn.mockResolvedValue(stateWithContents([shape]));
            const res = await runMcpFetcherAgent(baseParams());
            expect(res.text).toBe(shape);
        }
    });

    it('[Row 27] returns unicode / emoji / escaped-newline content verbatim', async () => {
        const s = '{"msg":"café → 😀\\n multi\\u00e9 line"}';
        mockRunFn.mockResolvedValue(stateWithContents([s]));
        expect((await runMcpFetcherAgent(baseParams())).text).toBe(s);
    });

    it('[Row 33] returns refusal prose verbatim (boundary does not detect refusals)', async () => {
        const refusal = "I'm sorry, but I cannot help with that request.";
        mockRunFn.mockResolvedValue(stateWithContents([refusal]));
        expect((await runMcpFetcherAgent(baseParams())).text).toBe(refusal);
    });

    it('[Rows 14/15/32] typed-empty text "" for empty steps / empty-string content, with valid shape', async () => {
        for (const state of [
            makeState({ steps: [] }), // Row 14/15: no steps
            stateWithContents(['']), // Row 32: empty success
        ]) {
            mockRunFn.mockResolvedValue(state);
            const res = await runMcpFetcherAgent(baseParams());
            expect(res.text).toBe('');
            expect(res.usage.totalTokens).toBe(0);
        }
    });

    it('[Row 16] whitespace-only content is NOT treated as an answer (returns "")', async () => {
        mockRunFn.mockResolvedValue(stateWithContents(['   \n\t  ']));
        expect((await runMcpFetcherAgent(baseParams())).text).toBe('');
    });

    it('[Row 17] null/undefined content is skipped; scan falls back to an earlier text step', async () => {
        mockRunFn.mockResolvedValue(
            stateWithContents(['EARLIER', null, undefined]),
        );
        expect((await runMcpFetcherAgent(baseParams())).text).toBe('EARLIER');
    });

    it('[Row 18] primitive (non-string) content is skipped -> ""', async () => {
        mockRunFn.mockResolvedValue(stateWithContents([true, 0, 42]));
        expect((await runMcpFetcherAgent(baseParams())).text).toBe('');
    });

    it('[Row 13] tolerates extra unknown keys on state/usage without crashing', async () => {
        const state = makeState({
            steps: [
                { index: 0, message: { role: 'assistant', content: 'ok' } },
            ],
            usage: {
                inputTokens: 4,
                outputTokens: 2,
                cacheReadTokens: 99, // extra key beyond input/output
            } as TokenUsage,
        });
        (state as any).__unknown = 'ignore-me';
        mockRunFn.mockResolvedValue(state);

        const res = await runMcpFetcherAgent(baseParams());
        expect(res.text).toBe('ok');
        expect(res.usage.totalTokens).toBe(6); // extra key ignored in total
    });

    it('return shape: usage.totalTokens defaults 0 when the runner reports no usage', async () => {
        mockRunFn.mockResolvedValue(makeState({ usage: {} }));
        const res = await runMcpFetcherAgent(baseParams());
        expect(res.usage).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: 0,
            reasoningTokens: undefined,
        });
    });

    // ---- #1786-class SILENT DEGRADATION -----------------------------------
    // extractFinalText (ai-sdk-fetcher.adapter.ts:211-218) requires
    // `typeof content === 'string'`. AgentMessage.content is documented as
    // `string | readonly unknown[]` — an assistant answer delivered as a
    // structured text-part array (`[{type:'text', text:'ANSWER'}]`) is silently
    // dropped and "" is returned WITH NO SIGNAL, masking a real payload. This
    // pins the CORRECT behavior (recover the text) so it goes RED when fixed.
    it.failing(
        '[Row 2] recovers text from a structured text-part array (currently drops it silently -> #1786)',
        async () => {
            mockRunFn.mockResolvedValue(
                stateWithContents([[{ type: 'text', text: 'ANSWER' }]]),
            );
            const res = await runMcpFetcherAgent(baseParams());
            expect(res.text).toBe('ANSWER');
        },
    );
});

// =========================================================================
// runMcpFetcherAgent — fail-safe (C) + reactive overflow fallback
// =========================================================================
describe('runMcpFetcherAgent — fail-safe & overflow fallback', () => {
    it('[Row 30] a runner.run rejection propagates (explicit failure, never a silent default)', async () => {
        mockRunFn.mockRejectedValue(new Error('network down'));
        await expect(runMcpFetcherAgent(baseParams())).rejects.toThrow(
            'network down',
        );
    });

    it('[Row 31] an error RunState is returned as a VALUE (no throw) when not an overflow', async () => {
        const errState = makeState({ status: 'error', steps: [] });
        mockRunFn.mockResolvedValue(errState);
        mockIsOverflow.mockReturnValue(false);

        const res = await runMcpFetcherAgent({
            ...baseParams(),
            contextWindowTokens: 50_000,
        });
        expect(res.state).toBe(errState);
        expect(res.text).toBe('');
        expect(mockRunFn).toHaveBeenCalledTimes(1); // no re-run
    });

    it('[Row 31/fallback] re-runs ONCE at 60% window when the failure is a context overflow', async () => {
        const overflowState = makeState({ status: 'error' });
        const recovered = stateWithContents(['RECOVERED']);
        mockRunFn
            .mockResolvedValueOnce(overflowState)
            .mockResolvedValueOnce(recovered);
        mockIsOverflow.mockReturnValue(true);

        const res = await runMcpFetcherAgent({
            ...baseParams(),
            contextWindowTokens: 100_000,
        });

        expect(mockRunFn).toHaveBeenCalledTimes(2);
        // both runs carry a real CompressionPolicy (the 2nd tighter at 60%)
        expect(mockRunFn.mock.calls[0][0].policies[0]).toBeInstanceOf(
            CompressionPolicy,
        );
        expect(mockRunFn.mock.calls[1][0].policies[0]).toBeInstanceOf(
            CompressionPolicy,
        );
        expect(res.text).toBe('RECOVERED');
    });

    it('[fallback guard] does NOT re-run on overflow when no window was set (short-circuit)', async () => {
        const overflowState = makeState({ status: 'error' });
        mockRunFn.mockResolvedValue(overflowState);
        mockIsOverflow.mockReturnValue(true);

        await runMcpFetcherAgent(baseParams()); // no contextWindowTokens
        expect(mockRunFn).toHaveBeenCalledTimes(1);
        // overflow detector never consulted (guarded by `contextWindowTokens &&`)
        expect(mockIsOverflow).not.toHaveBeenCalled();
    });

    it('[fallback guard] does NOT re-run a healthy run even with a window set', async () => {
        mockRunFn.mockResolvedValue(stateWithContents(['fine']));
        mockIsOverflow.mockReturnValue(false);

        await runMcpFetcherAgent({
            ...baseParams(),
            contextWindowTokens: 80_000,
        });
        expect(mockRunFn).toHaveBeenCalledTimes(1);
    });
});

// =========================================================================
// buildMcpAgentToolRegistry — tool wrapping (D input variants + fail-safe)
// =========================================================================
describe('buildMcpAgentToolRegistry', () => {
    it('[Row 35] empty tool set -> registry with empty list and undefined lookups', async () => {
        const reg = await buildMcpAgentToolRegistry(
            fakeAdapter({ getTools: [] }),
        );
        expect(reg.list()).toEqual([]);
        expect(reg.get('anything')).toBeUndefined();
    });

    it('[Row 36] single tool -> declared AgentTool shape, execute routes to adapter.executeTool', async () => {
        const adapter = fakeAdapter({
            getTools: [
                { name: 'get_issue', description: 'd', inputSchema: {} },
            ],
            executeTool: () => 'RESULT',
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        const tool = reg.get('get_issue')!;
        expect(tool).toMatchObject({
            name: 'get_issue',
            description: 'd',
        });
        expect(typeof tool.execute).toBe('function');
        expect(tool.inputSchema).toBeDefined();

        const out = await tool.execute({ id: 1 }, { runId: 'r' } as any);
        expect(out).toEqual({ output: 'RESULT' });
        expect(adapter.executeTool).toHaveBeenCalledWith('get_issue', {
            id: 1,
        });
    });

    it('[Row 39] fills defaults for missing description/inputSchema and passes {} for null input', async () => {
        const adapter = fakeAdapter({
            getTools: [{ name: 'bare' }], // no description, no inputSchema
            executeTool: () => 'ok',
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        const tool = reg.get('bare')!;
        expect(tool.description).toBe('');
        expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });

        await tool.execute(null as any, { runId: 'r' } as any);
        expect(adapter.executeTool).toHaveBeenCalledWith('bare', {});
    });

    it('[Row 40] serialization: object result -> JSON string, string result -> verbatim, nullish -> "null"', async () => {
        const cases: Array<[unknown, string]> = [
            [{ a: 1 }, JSON.stringify({ a: 1 })],
            ['plain', 'plain'],
            [null, 'null'],
            [undefined, 'null'],
        ];
        for (const [result, expected] of cases) {
            const adapter = fakeAdapter({
                getTools: [{ name: 't' }],
                executeTool: () => result,
            });
            const reg = await buildMcpAgentToolRegistry(adapter);
            const out = await reg
                .get('t')!
                .execute({}, { runId: 'r' } as any);
            expect(out).toEqual({ output: expected });
            expect(out.isError).toBeUndefined();
        }
    });

    it('[Row 30] tool failure is surfaced as {isError:true}, NEVER thrown past the boundary', async () => {
        const adapter = fakeAdapter({
            getTools: [{ name: 'boom' }],
            executeTool: () => {
                throw new Error('tool exploded');
            },
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        const out = await reg.get('boom')!.execute({}, { runId: 'r' } as any);
        expect(out).toEqual({ output: 'tool exploded', isError: true });
    });

    it('[Row 30] non-Error throw is stringified into the error output', async () => {
        const adapter = fakeAdapter({
            getTools: [{ name: 'boom' }],
            executeTool: () => {
                throw 'string failure'; // eslint-disable-line no-throw-literal
            },
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        const out = await reg.get('boom')!.execute({}, { runId: 'r' } as any);
        expect(out).toEqual({ output: 'string failure', isError: true });
    });

    it('[Row 38] duplicate tool names -> last definition wins (Map dedup), list has one', async () => {
        const adapter = fakeAdapter({
            getTools: [
                { name: 'dup', description: 'first' },
                { name: 'dup', description: 'second' },
            ],
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        expect(reg.list()).toHaveLength(1);
        expect(reg.get('dup')!.description).toBe('second');
    });

    it('[Row 40 special-chars] tool args are passed to adapter.executeTool verbatim', async () => {
        const adapter = fakeAdapter({
            getTools: [{ name: 't' }],
            executeTool: () => 'ok',
        });
        const reg = await buildMcpAgentToolRegistry(adapter);
        const weird = { q: '→ 😀 \n\t <b>', empty: '' };
        await reg.get('t')!.execute(weird, { runId: 'r' } as any);
        expect(adapter.executeTool).toHaveBeenCalledWith('t', weird);
    });

    it('[Row 42] tool order permutation yields equivalent lookups (metamorphic)', async () => {
        const a = { name: 'a', description: 'A' };
        const b = { name: 'b', description: 'B' };
        const c = { name: 'c', description: 'C' };
        const reg1 = await buildMcpAgentToolRegistry(
            fakeAdapter({ getTools: [a, b, c] }),
        );
        const reg2 = await buildMcpAgentToolRegistry(
            fakeAdapter({ getTools: [c, a, b] }),
        );
        for (const n of ['a', 'b', 'c']) {
            expect(reg1.get(n)!.description).toBe(reg2.get(n)!.description);
        }
        expect(reg1.list().map((t) => t.name).sort()).toEqual(
            reg2.list().map((t) => t.name).sort(),
        );
    });
});
