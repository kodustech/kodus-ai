/**
 * AiSdkAgentRunner compression regression (mocked model, ai/test).
 *
 * Reproduces the production crash "TypeError: message.content.filter is not a
 * function" that fires ONLY on long runs, right after a `context.compress`
 * event. Root cause: `tool` messages carry structured content (an array of
 * `tool-result` parts), but the harness stringifies that content at two seams
 * (toAgentMessage in the runner + the compressor output mapping) because
 * AgentMessage.content is typed `string`. When CompressionPolicy fires, the
 * compressed window is handed back to generateText with a STRING as the `tool`
 * message content; the AI SDK's `case "tool"` does `content.filter(...)` with
 * no string guard → TypeError.
 *
 * These are written BEFORE the fix (TDD):
 *   - "crashes ... when compression fires"  → RED today, green after the fix.
 *   - "completes normally when compression does NOT fire" → GUARD: green today
 *     AND after the fix, so the fix can't silently break the happy path.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { scriptedToolModel } from './__test-utils__/scripted-tool-model';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ProgressLedger } from '../../domain/contracts/progress.contract';
import type { AgentTool, ToolContext } from '../../domain/contracts/tool.contract';
import { ContextWindowCompressor } from '../compression/context-window-compressor';
import { CompletionGatePolicy } from '../policies/completion-gate.policy';
import { CompressionPolicy } from '../policies/compression.policy';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

// A tool result big enough (well above the compressor's 3_000-char "recent"
// cap) that compression actually truncates it and reports real token savings.
// Varied tokens (not a single repeated char, which tiktoken would collapse to
// a handful of tokens) so the token estimate reflects realistic dense content.
const BIG_RESULT = Array.from(
    { length: 1_600 },
    (_, i) => `const value${i} = compute(${i}, "path/to/file${i}.ts");`,
).join('\n');

// Scripted model: step 0 -> call readFile (produces a large `tool` message),
// step 1 -> call submitResult (finalize). Deterministic, no real LLM.
function scriptedModel() {
    return scriptedToolModel((turn) =>
        turn === 1
            ? { id: 'c1', name: 'readFile', input: { path: 'big.txt' } }
            : { id: 'c2', name: 'submitResult', input: { findings: [] } },
    );
}

// Same scripted tool-call model, but wraps doGenerate to record the raw params
// (including the message window) every call receives, so a test can prove which
// conversation window actually reached the model (#1808).
function recordedModel() {
    const received: any[] = [];
    const captured = scriptedModel();
    const original = captured.doGenerate.bind(captured);
    captured.doGenerate = (async (params: any) => {
        received.push(params);
        return original(params);
    }) as any;
    (captured as any).__received = received;
    return captured;
}

// Return the full stringified conversational payload of each model call a
// recorded model received. Exact AI-SDK message part shapes vary by version,
// but the whole `prompt` is what reaches the model — stringifying it gives a
// discriminating, stable read for the note/compression assertions without
// coupling to a specific part structure.
function receivedMessageTexts(model: any): string[] {
    const received: any[] = model?.__received ?? [];
    const texts: string[] = [];
    for (const params of received) {
        const prompt =
            params?.prompt ?? params?.input?.messages ?? params?.messages;
        if (prompt !== undefined) {
            texts.push(JSON.stringify(prompt));
        }
    }
    return texts;
}

const mockResolve = resolveModelConfig as jest.Mock;
const wireVal = (model: any) => ({
    model,
    callOptions: {},
    providerOptions: {},
    modelName: 'mock',
    usageIdentity: {},
});
beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockImplementation(() => wireVal(scriptedModel()));
});

// Scripted model that runs `readSteps` readFile calls (each returns a big
// result that piles into the window) before finalizing. Drives the tool-loop
// accumulation that overflows the window in issue #1574.
function accumulatingModel(readSteps: number) {
    return scriptedToolModel((turn) =>
        turn <= readSteps
            ? { id: `c${turn}`, name: 'readFile', input: { path: `f${turn}.ts` } }
            : { id: 'done', name: 'submitResult', input: { findings: [] } },
    );
}

const readFileTool: AgentTool = {
    name: 'readFile',
    description: 'read a file',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
    execute: async () => ({ output: BIG_RESULT }),
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

// A ledger that reports pending work (so CompletionGatePolicy.prepareStep()
// injects a steering note on every step) yet has NO critical pending once done
// is called — so the gate honors the finalize instead of vetoing the run
// forever. This lets the note-injection and compression coexist on one step,
// which is exactly the #1808 scenario.
function debtLedger(): ProgressLedger {
    return {
        markFromToolCall: () => undefined,
        summary: () => ({
            totalTargets: 2,
            pendingTargets: 0,
            criticalTotal: 0,
            criticalPending: 0,
        }),
        debtNote: () => 'review the pending critical finding',
    };
}

const ctx: ToolContext = { runId: 'compress-e2e-1' };

function specWithContextWindow(
    contextWindowTokens: number,
    overheadTokens = 0,
): AgentSpec {
    return {
        id: 'generalist',
        systemPrompt: 'review the diff',
        tools: new InMemoryToolRegistry([readFileTool, doneTool]),
        policies: [
            new CompressionPolicy(
                new ContextWindowCompressor(contextWindowTokens, {
                    overheadTokens,
                }),
            ),
            new CompletionGatePolicy(noCriticalLedger(), {
                doneToolName: 'submitResult',
            }),
        ],
        maxSteps: 20,
        resultToolName: 'submitResult',
    };
}

// Compression + a policy that injects a steering note in the SAME prepareStep
// (#1808): the regression that let an injectNote discard the compressed window
// and resend the uncompressed conversation to the model.
function specWithDebtNoteAndContextWindow(
    contextWindowTokens: number,
): AgentSpec {
    return {
        id: 'generalist',
        systemPrompt: 'review the diff',
        tools: new InMemoryToolRegistry([readFileTool, doneTool]),
        policies: [
            new CompressionPolicy(
                new ContextWindowCompressor(contextWindowTokens, {}),
            ),
            new CompletionGatePolicy(debtLedger(), {
                doneToolName: 'submitResult',
            }),
        ],
        maxSteps: 20,
        resultToolName: 'submitResult',
    };
}

describe('AiSdkAgentRunner + CompressionPolicy (context compression e2e)', () => {
    // RED before the fix: a tiny context window forces compression on the
    // second step; the compressed `tool` message reaches generateText as a
    // string and the SDK crashes on content.filter. The runner captures the
    // throw into RunState{status:'error'} with the original message in trace.
    it('completes (does not crash on tool content.filter) when compression fires on a long run', async () => {
        const runner = new AiSdkAgentRunner(undefined);
        // window=1 token -> shouldCompress is always true; the big tool result
        // guarantees real savings so maybeCompress returns a compressed window.
        const state = await runner.run(
            specWithContextWindow(1),
            { prompt: 'go' },
            ctx,
        );

        // The compression event must have actually fired (else this test
        // wouldn't exercise the bug at all).
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(true);

        // The bug: an error trace event carrying the SDK's TypeError.
        const filterError = state.trace.find(
            (e) =>
                e.kind === 'error' &&
                /content\.filter is not a function|filter is not a function/i.test(
                    String(e.detail?.message ?? ''),
                ),
        );
        expect(filterError).toBeUndefined();

        // And the run finishes instead of erroring out.
        expect(state.status).not.toBe('error');
    });

    // GUARD: green before AND after the fix. A large context window means
    // compression never triggers, so structured messages flow through
    // untouched and the loop finalizes normally. Protects the happy path.
    it('completes normally when compression does NOT fire (no context overflow)', async () => {
        const runner = new AiSdkAgentRunner(undefined);
        const state = await runner.run(
            specWithContextWindow(1_000_000),
            { prompt: 'go' },
            ctx,
        );

        // Compression must NOT have fired in this scenario.
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(false);
        expect(
            state.trace.some((e) => e.kind === 'error'),
        ).toBe(false);

        // The loop drove readFile then submitResult, and the completion gate
        // honored the done tool.
        expect(state.status).toBe('stopped');
        expect(state.stopReason).toBe('completion-gate');
        expect(state.artifacts).toHaveLength(1);
        expect(state.artifacts[0]).toMatchObject({
            type: 'submitResult',
            payload: { findings: [] },
        });
    });

    // REGRESSION (issue #1574): a tool loop that accumulates far more than the
    // window of tool results must be clamped every step and finish, instead of
    // shipping an oversized request. Realistic window + overhead so the real
    // budget (window − overhead − margin) is what the clamp must respect.
    it('clamps an accumulating tool loop that would otherwise overflow the window', async () => {
        mockResolve.mockReturnValue(wireVal(accumulatingModel(12)));
        const runner = new AiSdkAgentRunner(undefined);

        // 12 readFile steps × 8_000-char results ≈ well over a 40K-token window.
        const state = await runner.run(
            specWithContextWindow(40_000, 12_000),
            { prompt: 'go' },
            ctx,
        );

        // Compression must have fired (the loop overflowed and was clamped)...
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(true);
        // ...and the run finished cleanly (no provider CONTEXT_OVERFLOW throw,
        // no content.filter crash).
        expect(state.status).not.toBe('error');
        expect(
            state.trace.some((e) => e.kind === 'error'),
        ).toBe(false);
        // Findings still produced — the review completes rather than failing.
        expect(state.artifacts).toHaveLength(1);
        expect(state.artifacts[0]).toMatchObject({ type: 'submitResult' });
    });

    // REGRESSION (issue #1808): when compression and a steering-note
    // injection fire in the SAME prepareStep, the note must be appended to the
    // COMPRESSED window — never to the uncompressed conversation. The old code
    // rebuilt the message list from `(msgs ?? messages)` in the injectNote
    // branch, discarding `merged.messages`, so the model received the huge raw
    // tool result and the context clamp was bypassed.
    it('appends a steering note to the compressed window, not the raw conversation (#1808)', async () => {
        let model: any;
        mockResolve.mockImplementation(() => {
            if (!model) {
                model = recordedModel();
            }
            return wireVal(model);
        });
        const runner = new AiSdkAgentRunner(undefined);

        // Tiny window → compression always fires; debt ledger → CompletionGate
        // injects a steering note on every prepareStep.
        const state = await runner.run(
            specWithDebtNoteAndContextWindow(1),
            { prompt: 'go' },
            ctx,
        );

        // Both directives actually fired (else the test wouldn't exercise the bug).
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(true);
        expect(
            state.trace.some((e) => e.kind === 'progress.debt'),
        ).toBe(true);

        // The windows the model actually received across its calls.
        const received = receivedMessageTexts(model);

        // The steering note reached the model...
        expect(
            received.some((text) =>
                text.includes('review the pending critical finding'),
            ),
        ).toBe(true);

        // ...but the model saw the COMPRESSED window: no full-size raw tool
        // result baked into a later call. The bug resent the whole BIG_RESULT;
        // the fix sends the truncated/compressed form, so the marker line of the
        // raw result must not appear verbatim in a window that also carries the
        // note.
        for (const text of received) {
            if (text.includes('review the pending critical finding')) {
                expect(text).not.toContain('const value1599 =');
            }
        }

        // And the run completed cleanly, producing a result artifact.
        expect(state.status).not.toBe('error');
        expect(state.artifacts).toHaveLength(1);
        expect(state.artifacts[0]).toMatchObject({ type: 'submitResult' });
    });
});
