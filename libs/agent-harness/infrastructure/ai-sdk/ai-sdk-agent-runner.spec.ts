/**
 * AiSdkAgentRunner — LLM.run boundary CONTRACT suite.
 *
 * This closes the full LLM.run I/O contract matrix for the ONE agent loop in the
 * harness (the runner all 3 consumers share: the code-review finder/verify, the
 * conversation agent, the business-rules agent). It is a companion to the parity
 * suites (`*.e2e.spec.ts`, `*.telemetry.spec.ts`) — it never deletes them; it
 * pins the DETERMINISTIC layer of the boundary:
 *
 *   1. REQUEST ASSEMBLY — the exact args threaded into LLM.run (slot/byokConfig,
 *      system, messages, temperature, maxOutputTokens, providerOptions, signal,
 *      the observability naming + cost attrs, and the loop seams).
 *   2. OUTPUT PARSE / ENVELOPE — how a model tool-call payload is materialized
 *      into `RunState.artifacts` (`parseArtifactInput` / `materializeArtifacts`):
 *      the "output-shape zoo" arrives as tool-call input, and the boundary must
 *      round-trip it faithfully OR fall back observably, never drop/mangle it.
 *   3. FAIL-SAFE + RETURN SHAPE — a provider throw / abort / empty-success /
 *      refusal becomes a well-formed RunState (never an exception past the
 *      boundary, never a silently-wrong "completed").
 *
 * SCOPE = the deterministic seam only. Whether a finding is CORRECT is the eval
 * track, out of scope here.
 *
 * We mock the real LLM.run boundary and RESTORE (mockReset) after each test, so
 * the sibling parity suites keep passing. `readAiSdkUsage` is the REAL reader
 * (only LLM.run is mocked) so the usage-mapping seam is exercised too.
 *
 * Model-policy note (matrix dimension E): the json_schema-vs-json_object gate
 * lives in `structured-output-gate.ts`, owned by LLM.run — NOT by this boundary.
 * This runner runs a tool loop; it never chooses the structured-output mode.
 * What DOES vary by provider family AT THIS BOUNDARY is the tool-call `input`
 * encoding: strict/native providers deliver it as a parsed OBJECT, json_object
 * / *_compatible providers deliver it as a JSON STRING. `parseArtifactInput`
 * is the seam that must handle both, so the E rows are exercised there — every
 * off-schema payload row is run in BOTH the object form and the string form.
 */
jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';

import type { AgentSpec, AgentRunInput } from '../../domain/contracts/agent.contract';
import type { AgentPolicy } from '../../domain/contracts/policy.contract';
import type { ToolContext, AgentTool } from '../../domain/contracts/tool.contract';
import type { RunState } from '../../domain/contracts/run-state.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const mockRun = LLM.run as jest.Mock;

const RESULT_TOOL = 'submitResult';

const doneTool: AgentTool = {
    name: RESULT_TOOL,
    description: 'finalize',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'ok' }),
};

const echoTool: AgentTool = {
    name: 'echo',
    description: 'echo',
    inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    execute: async (i: any) => ({ output: `echo:${i.text}` }),
};

const ctx: ToolContext = { runId: 'run-1' };

function baseSpec(over: Partial<AgentSpec> = {}): AgentSpec {
    return {
        id: 'finder',
        systemPrompt: 'find bugs',
        tools: new InMemoryToolRegistry([echoTool, doneTool]),
        policies: [],
        maxSteps: 10,
        resultToolName: RESULT_TOOL,
        ...over,
    };
}

/**
 * One onStepFinish event in the shape the SDK hands the runner.
 * `finishReason` is the `{ unified, raw }` object of the current provider shape.
 */
function toolCallEvent(
    input: unknown,
    opts: {
        name?: string;
        text?: string;
        finishReason?: string;
        executed?: boolean;
    } = {},
): any {
    const {
        name = RESULT_TOOL,
        text = '',
        finishReason = 'tool-calls',
        executed = true,
    } = opts;
    return {
        text,
        toolCalls: [{ toolCallId: 'tc1', toolName: name, input }],
        toolResults: executed ? [{ toolCallId: 'tc1' }] : [],
        finishReason: { unified: finishReason, raw: finishReason },
        usage: { inputTokens: 3, outputTokens: 2 },
    };
}

interface DriveOpts {
    events?: any[];
    result?: any;
    throwErr?: unknown;
}

let capturedReq: any;

/** Wire LLM.run to (optionally) replay onStepFinish events, then resolve/throw. */
function drive(opts: DriveOpts = {}): void {
    mockRun.mockImplementation(async (req: any) => {
        capturedReq = req;
        for (const ev of opts.events ?? []) {
            await req.loop.onStepFinish(ev);
        }
        if ('throwErr' in opts && opts.throwErr !== undefined) {
            throw opts.throwErr;
        }
        return (
            opts.result ?? { usage: { inputTokens: 1, outputTokens: 1 }, steps: [] }
        );
    });
}

/** Run the runner once with a given spec/input, returning state + captured req. */
async function runOnce(
    opts: DriveOpts & {
        spec?: Partial<AgentSpec>;
        input?: AgentRunInput;
        slot?: any;
        modelOpts?: any;
        runCtx?: ToolContext;
    } = {},
): Promise<{ state: RunState; req: any }> {
    drive(opts);
    const runner = new AiSdkAgentRunner(opts.slot, opts.modelOpts);
    const state = await runner.run(
        baseSpec(opts.spec),
        opts.input ?? { prompt: 'go' },
        opts.runCtx ?? ctx,
    );
    return { state, req: capturedReq };
}

/** The universal invariant: the boundary ALWAYS returns a well-formed RunState. */
function assertWellFormed(state: RunState): void {
    expect(state).toBeDefined();
    expect(typeof state.runId).toBe('string');
    expect(typeof state.agentId).toBe('string');
    expect(['completed', 'stopped', 'budget-exhausted', 'error']).toContain(
        state.status,
    );
    expect(Array.isArray(state.steps)).toBe(true);
    expect(Array.isArray(state.artifacts)).toBe(true);
    expect(Array.isArray(state.trace)).toBe(true);
    expect(state.usage).toBeDefined();
    expect(typeof state.usage).toBe('object');
}

/** Payload of the single materialized artifact (fails loudly if not exactly 1). */
function soleArtifactPayload(state: RunState): unknown {
    expect(state.artifacts).toHaveLength(1);
    return state.artifacts[0].payload;
}

beforeEach(() => {
    mockRun.mockReset();
    capturedReq = undefined;
});

afterEach(() => {
    mockRun.mockReset();
});

// ───────────────────────────────────────────────────────────────────────────
// REQUEST ASSEMBLY — the deterministic "config in → wire out" for 3 consumers.
// ───────────────────────────────────────────────────────────────────────────
describe('request assembly (LLM.run args)', () => {
    it('threads the slot as byokConfig and the modelOpts knobs verbatim (finder consumer)', async () => {
        const slot = { provider: 'anthropic', model: 'claude' } as any;
        const reporter = jest.fn();
        const { req } = await runOnce({
            slot,
            modelOpts: {
                organizationId: 'org-1',
                provider: 'anthropic',
                queueTimeoutMs: 1234,
                reporter,
            },
        });
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(req.byokConfig).toBe(slot);
        expect(req.organizationId).toBe('org-1');
        expect(req.provider).toBe('anthropic');
        expect(req.queueTimeoutMs).toBe(1234);
        expect(req.reporter).toBe(reporter);
    });

    it('passes system prompt and the user prompt as a user message', async () => {
        const { req } = await runOnce({ input: { prompt: 'review this diff' } });
        expect(req.system).toBe('find bugs');
        expect(req.messages).toEqual([
            { role: 'user', content: 'review this diff' },
        ]);
    });

    it('prepends seed messages before the user prompt, in order', async () => {
        const { req } = await runOnce({
            input: {
                prompt: 'now do it',
                seedMessages: [
                    { role: 'user', content: 'earlier ask' },
                    { role: 'assistant', content: 'earlier reply' },
                ],
            },
        });
        expect(req.messages).toEqual([
            { role: 'user', content: 'earlier ask' },
            { role: 'assistant', content: 'earlier reply' },
            { role: 'user', content: 'now do it' },
        ]);
    });

    it('forwards temperature / maxOutputTokens / providerOptions ONLY when set', async () => {
        const providerOptions = { anthropic: { thinking: { type: 'enabled' } } };
        const { req } = await runOnce({
            spec: {
                temperature: 0.2,
                maxOutputTokens: 4096,
                providerOptions,
            },
        });
        expect(req.temperature).toBe(0.2);
        expect(req.maxOutputTokens).toBe(4096);
        expect(req.providerOptions).toBe(providerOptions);
    });

    it('omits temperature / maxOutputTokens / providerOptions when unset (slot defaults win)', async () => {
        const { req } = await runOnce();
        expect('temperature' in req).toBe(false);
        expect('maxOutputTokens' in req).toBe(false);
        expect('providerOptions' in req).toBe(false);
    });

    it('threads ctx.signal for cancellation/timeout', async () => {
        const controller = new AbortController();
        const runCtx: ToolContext = { runId: 'sig', signal: controller.signal };
        const { req } = await runOnce({ runCtx });
        expect(req.signal).toBe(controller.signal);
    });

    it('sets observability naming + the harness cost attrs', async () => {
        const { req } = await runOnce({
            spec: {
                runName: 'conversationAgent',
                agentName: 'ConversationalAgent',
                phase: 'conversation',
                spanName: 'ConversationalAgent::conversationAgent',
            },
        });
        expect(req.runName).toBe('conversationAgent');
        expect(req.spanName).toBe('ConversationalAgent::conversationAgent');
        expect(req.attrs).toMatchObject({
            agentName: 'ConversationalAgent',
            phase: 'conversation',
            source: 'harness',
        });
    });

    it('runName falls back agentName → id when unset', async () => {
        const { req: r1 } = await runOnce({
            spec: { runName: undefined, agentName: 'AgentX' },
        });
        expect(r1.runName).toBe('AgentX');
        const { req: r2 } = await runOnce({
            spec: { runName: undefined, agentName: undefined, id: 'bare-id' },
        });
        expect(r2.runName).toBe('bare-id');
    });

    it('reads prNumber/teamId from runtimeContext for the cost attrs (finder opt-in)', async () => {
        const { req } = await runOnce({
            input: {
                prompt: 'go',
                runtimeContext: { pullRequestId: 42, teamId: 'team-9' },
            },
        });
        expect(req.attrs).toMatchObject({ prNumber: 42, teamId: 'team-9' });
    });

    it('falls back to telemetryMetadata for prNumber/teamId when no runtimeContext', async () => {
        const { req } = await runOnce({
            input: {
                prompt: 'go',
                telemetryMetadata: { pullRequestId: 7, teamId: 'team-3' },
            },
        });
        expect(req.attrs).toMatchObject({ prNumber: 7, teamId: 'team-3' });
    });

    it('omits prNumber/teamId from attrs when neither source carries them', async () => {
        const { req } = await runOnce();
        expect('prNumber' in req.attrs).toBe(false);
        expect('teamId' in req.attrs).toBe(false);
    });

    it('forwards raw telemetryMetadata verbatim (LLM.run builds the SDK shape)', async () => {
        const meta = { organizationId: 'o', repositoryId: 'r' };
        const { req } = await runOnce({
            input: { prompt: 'go', telemetryMetadata: meta },
        });
        expect(req.telemetryMetadata).toEqual(meta);
    });

    it('hands LLM.run the loop seams (tools + maxSteps + the 3 policy hooks)', async () => {
        const { req } = await runOnce({ spec: { maxSteps: 5 } });
        expect(req.loop.maxSteps).toBe(5);
        expect(req.loop.tools).toHaveProperty(RESULT_TOOL);
        expect(req.loop.tools).toHaveProperty('echo');
        expect(Array.isArray(req.loop.stopWhen)).toBe(true);
        expect(typeof req.loop.prepareStep).toBe('function');
        expect(typeof req.loop.onStepFinish).toBe('function');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// A. OUTPUT-SHAPE ZOO — arrives as the result-tool call `input`; the boundary
//    materializes it into artifacts.payload. It must round-trip FAITHFULLY
//    (the runner is generic — reshaping/aliasing is the DOMAIN's job) or fall
//    back OBSERVABLY. Every row is run in BOTH provider encodings (matrix E):
//    OBJECT (strict/native) and JSON STRING (json_object / *_compatible).
// ───────────────────────────────────────────────────────────────────────────
describe('A. output-shape zoo — faithful capture / observable fallback', () => {
    // Row 1 — exact D
    it('row1: exact D object → payload captured exactly', async () => {
        const D = { findings: [{ id: 1 }], unique: [0] };
        const { state } = await runOnce({ events: [toolCallEvent(D)] });
        expect(soleArtifactPayload(state)).toEqual(D);
    });

    // Row 1 under the json_object family: tool args as a JSON string.
    it('row1/E: exact D as a JSON STRING (json_object family) → parsed to D', async () => {
        const D = { findings: [{ id: 1 }], unique: [0] };
        const { state } = await runOnce({
            events: [toolCallEvent(JSON.stringify(D))],
        });
        expect(soleArtifactPayload(state)).toEqual(D);
    });

    // Row 2 — bare array where D is an object
    it('row2: bare array payload is preserved (not silently coerced/dropped)', async () => {
        const arr = [{ a: 1 }, { a: 2 }];
        const objForm = await runOnce({ events: [toolCallEvent(arr)] });
        expect(soleArtifactPayload(objForm.state)).toEqual(arr);
        const strForm = await runOnce({
            events: [toolCallEvent(JSON.stringify(arr))],
        });
        expect(soleArtifactPayload(strForm.state)).toEqual(arr);
    });

    // Row 3 — single object where an array is expected (and vice-versa)
    it('row3: single object / single-element mismatch preserved verbatim', async () => {
        const single = { id: 'only' };
        const { state } = await runOnce({ events: [toolCallEvent(single)] });
        expect(soleArtifactPayload(state)).toEqual(single);
    });

    // Row 4 — wrapper key {result:D}/{data:D}/… (runner does NOT unwrap; faithful)
    it('row4: wrapper-key envelope preserved verbatim (unwrapping is the domain job)', async () => {
        for (const wrap of ['result', 'data', 'output', 'response', 'json']) {
            const payload = { [wrap]: { keep: true } };
            const { state } = await runOnce({ events: [toolCallEvent(payload)] });
            expect(soleArtifactPayload(state)).toEqual(payload);
        }
    });

    // Row 5 — double wrapper
    it('row5: double wrapper preserved verbatim', async () => {
        const payload = { result: { result: { keep: true } } };
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 6 — numeric/opaque single-key wrap
    it('row6: numeric/opaque single-key wrap preserved verbatim', async () => {
        const payload = { '0': { keep: true }, content: { x: 1 } };
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 7 — stringified JSON (the core RECOVER path: json_object tool args)
    it('row7: stringified JSON tool args → recovered to the object', async () => {
        const D = { queryTasks: ['a', 'b'] };
        const { state } = await runOnce({
            events: [toolCallEvent(JSON.stringify(D))],
        });
        expect(soleArtifactPayload(state)).toEqual(D);
    });

    // Row 8 — markdown-fenced string (not valid JSON → documented raw fallback)
    it('row8: markdown-fenced string tool args → raw string fallback, no throw (observable non-object)', async () => {
        const fenced = '```json\n{"keep":true}\n```';
        const { state } = await runOnce({ events: [toolCallEvent(fenced)] });
        // parseArtifactInput cannot JSON.parse a fenced string; it falls back to
        // the raw value. That is OBSERVABLE (payload is a string, not an object),
        // so a domain can detect it — it is NOT a silently-wrong object.
        expect(soleArtifactPayload(state)).toBe(fenced);
    });

    // Row 9 — prose-wrapped string (not valid JSON → documented raw fallback)
    it('row9: prose-wrapped string tool args → raw string fallback, no throw', async () => {
        const prose = 'Here is the result: {"keep":true}';
        const { state } = await runOnce({ events: [toolCallEvent(prose)] });
        expect(soleArtifactPayload(state)).toBe(prose);
    });

    // Row 10 — right data, wrong keys (renamed) — faithful passthrough
    it('row10: renamed keys preserved verbatim (no silent aliasing)', async () => {
        const payload = { duplicateGroups: [[0, 1]], uniqueIndices: [2] };
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 11a — case/convention mismatch on the PAYLOAD KEYS — faithful passthrough
    it('row11a: case/convention key mismatch preserved verbatim', async () => {
        const payload = { query_tasks: ['x'], Keep: 'true' };
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 11b — case mismatch on the RESULT-TOOL NAME: prod drops it SILENTLY.
    // materializeArtifacts uses an exact `tc.name !== resultToolName` match
    // (ai-sdk-agent-runner.ts:506), so a near-miss name yields ZERO artifacts
    // and the run still reports 'completed' with no signal — the #1786 class.
    // Pinned as it.failing: green today, RED when the boundary recovers the
    // call (case-insensitive capture) or emits a near-miss trace event.
    it.failing(
        'row11b: result-tool name differing only by case is captured or signalled (KNOWN silent drop, ai-sdk-agent-runner.ts:506)',
        async () => {
            const { state } = await runOnce({
                events: [toolCallEvent({ findings: [] }, { name: 'submitresult' })],
            });
            const captured = state.artifacts.length === 1;
            const signalled = state.trace.some(
                (e) => e.kind.includes('skip') || e.kind.includes('near'),
            );
            expect(captured || signalled).toBe(true);
        },
    );

    // Row 12 — partial object (only some required keys)
    it('row12: partial object preserved verbatim (validation is the domain job)', async () => {
        const payload = { findings: [{ id: 1 }] }; // missing `unique`
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 13 — extra unknown keys alongside the right ones
    it('row13: extra unknown keys tolerated, not dropped, not a crash', async () => {
        const payload = { keep: true, __debug: 'x', trace: [1, 2] };
        const { state } = await runOnce({ events: [toolCallEvent(payload)] });
        assertWellFormed(state);
        expect(soleArtifactPayload(state)).toEqual(payload);
    });

    // Row 14 — empty object
    it('row14: empty object → payload {}', async () => {
        const { state } = await runOnce({ events: [toolCallEvent({})] });
        expect(soleArtifactPayload(state)).toEqual({});
    });

    // Row 15 — empty array
    it('row15: empty array → payload []', async () => {
        const objForm = await runOnce({ events: [toolCallEvent([])] });
        expect(soleArtifactPayload(objForm.state)).toEqual([]);
        const strForm = await runOnce({ events: [toolCallEvent('[]')] });
        expect(soleArtifactPayload(strForm.state)).toEqual([]);
    });

    // Row 16 — empty string / whitespace-only
    it('row16: empty / whitespace-only string tool args → raw fallback, no throw', async () => {
        const empty = await runOnce({ events: [toolCallEvent('')] });
        expect(soleArtifactPayload(empty.state)).toBe('');
        const ws = await runOnce({ events: [toolCallEvent('   \n\t ')] });
        expect(soleArtifactPayload(ws.state)).toBe('   \n\t ');
    });

    // Row 17 — null / undefined tool input
    it('row17: null/undefined tool input → payload undefined, no throw', async () => {
        // eventToMessage coalesces `tc.input ?? tc.args`, so a null input maps
        // to undefined (both mean "no structured value"); neither throws.
        const nul = await runOnce({ events: [toolCallEvent(null)] });
        assertWellFormed(nul.state);
        expect(soleArtifactPayload(nul.state)).toBeUndefined();
        const und = await runOnce({ events: [toolCallEvent(undefined)] });
        assertWellFormed(und.state);
        expect(soleArtifactPayload(und.state)).toBeUndefined();
    });

    // Row 18 — primitive where object expected
    it('row18: primitive tool input preserved (number/boolean passthrough; bare word → raw)', async () => {
        const num = await runOnce({ events: [toolCallEvent(0)] });
        expect(soleArtifactPayload(num.state)).toBe(0);
        const bool = await runOnce({ events: [toolCallEvent(true)] });
        expect(soleArtifactPayload(bool.state)).toBe(true);
        // "ok" as a raw string is not valid JSON → raw-string fallback
        const word = await runOnce({ events: [toolCallEvent('ok')] });
        expect(soleArtifactPayload(word.state)).toBe('ok');
        // '"ok"' (a JSON string literal) parses to the string "ok"
        const jsonStr = await runOnce({ events: [toolCallEvent('"ok"')] });
        expect(soleArtifactPayload(jsonStr.state)).toBe('ok');
    });

    // Row 19 — provider envelope leak arriving as tool input
    it('row19: provider-envelope-shaped tool input preserved verbatim (no crash)', async () => {
        const envelope = {
            choices: [{ message: { content: '{"keep":true}' } }],
        };
        const { state } = await runOnce({ events: [toolCallEvent(envelope)] });
        assertWellFormed(state);
        expect(soleArtifactPayload(state)).toEqual(envelope);
    });

    // Row 20 — reasoning/thinking leak: the runner captures event.text only,
    // so a `reasoning` field on the step event never leaks into message content.
    it('row20: reasoning/thinking on the step event does NOT leak into the captured message content', async () => {
        const ev = toolCallEvent({ keep: true }, { text: 'visible answer' });
        (ev as any).reasoning = 'secret chain of thought';
        (ev as any).reasoningText = 'secret chain of thought';
        const { state } = await runOnce({ events: [ev] });
        const msg = state.steps[0].message;
        expect(msg.content).toBe('visible answer');
        expect(JSON.stringify(msg)).not.toContain('secret chain of thought');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// B. SEMANTIC-BUT-WRONG — valid JSON, wrong value encoding. The runner is a
//    generic capture layer with no per-field schema, so the invariant is
//    FIDELITY: the raw value survives verbatim into the payload (no silent
//    coercion, no drop) — the domain owns interpretation.
// ───────────────────────────────────────────────────────────────────────────
describe('B. semantic-but-wrong — verbatim fidelity (no silent coercion)', () => {
    it('row21: boolean-as-string preserved as the string, not coerced', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ keep: 'true' })],
        });
        const p = soleArtifactPayload(state) as any;
        expect(p.keep).toBe('true');
        expect(p.keep).not.toBe(true);
    });

    it('row22: boolean-as-yes/no preserved verbatim', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ keep: 'yes' })],
        });
        expect((soleArtifactPayload(state) as any).keep).toBe('yes');
    });

    it('row23: boolean-as-number preserved verbatim', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ keep: 1 })],
        });
        expect((soleArtifactPayload(state) as any).keep).toBe(1);
    });

    it('row24: out-of-set enum/severity preserved verbatim (not defaulted)', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ severity: 'URGENT' })],
        });
        expect((soleArtifactPayload(state) as any).severity).toBe('URGENT');
    });

    it('row25: dangling/out-of-range index preserved verbatim (not clamped)', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ unique: [999] })],
        });
        expect((soleArtifactPayload(state) as any).unique).toEqual([999]);
    });

    it('row26: duplicate keys in a JSON-string payload resolve last-wins (JSON.parse)', async () => {
        // Valid-ish JSON text with a duplicated key; JSON.parse keeps the last.
        const { state } = await runOnce({
            events: [toolCallEvent('{"keep":true,"keep":false}')],
        });
        expect((soleArtifactPayload(state) as any).keep).toBe(false);
    });

    it('row27: unicode / emoji / escaped newlines survive the parse verbatim', async () => {
        const payload = { note: 'café 🚀 line1\nline2\t✓' };
        const strForm = await runOnce({
            events: [toolCallEvent(JSON.stringify(payload))],
        });
        expect(soleArtifactPayload(strForm.state)).toEqual(payload);
        const objForm = await runOnce({ events: [toolCallEvent(payload)] });
        expect(soleArtifactPayload(objForm.state)).toEqual(payload);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C. UNPARSEABLE / TRANSPORT — the fail-safe layer. Never throw past the
//    boundary; never ship a silently-wrong "completed".
// ───────────────────────────────────────────────────────────────────────────
describe('C. unparseable / transport — documented fail-safe', () => {
    it('row28: truncated JSON tool args → raw fallback, no throw', async () => {
        const truncated = '{"findings":[{"id":1},{"id":';
        const { state } = await runOnce({ events: [toolCallEvent(truncated)] });
        assertWellFormed(state);
        expect(soleArtifactPayload(state)).toBe(truncated);
    });

    it('row28b: a tool call left UNEXECUTED on a truncated (length) finish is surfaced as tool.skipped', async () => {
        const { state } = await runOnce({
            events: [
                toolCallEvent(
                    { text: 'hi' },
                    { name: 'echo', finishReason: 'length', executed: false },
                ),
            ],
        });
        const skipped = state.trace.find((e) => e.kind === 'tool.skipped');
        expect(skipped).toBeDefined();
        expect((skipped?.detail as any)?.finishReason).toBe('length');
    });

    it('row29: malformed JSON (trailing comma / single quotes / unquoted key) → raw fallback, no throw', async () => {
        for (const bad of [
            '{"a":1,}',
            "{'a':1}",
            '{a:1}',
        ]) {
            const { state } = await runOnce({ events: [toolCallEvent(bad)] });
            assertWellFormed(state);
            expect(soleArtifactPayload(state)).toBe(bad);
        }
    });

    it('row30: LLM.run throws → RunState{status:error}, never an exception past the boundary', async () => {
        const { state } = await runOnce({
            throwErr: new Error('boom: provider rejected'),
        });
        expect(state.status).toBe('error');
        expect(state.stopReason).toBe('error');
        const err = state.trace.find((e) => e.kind === 'error');
        expect(err).toBeDefined();
        expect(String(err?.detail?.message)).toContain('boom');
    });

    it('row30b: a thrown provider error carries statusCode + responseBody into the error trace (#1568)', async () => {
        const httpErr: any = new Error('Not Found');
        httpErr.statusCode = 404;
        httpErr.responseBody = '{"error":"model_not_found"}';
        const { state } = await runOnce({ throwErr: httpErr });
        const err = state.trace.find((e) => e.kind === 'error');
        expect((err?.detail as any)?.status).toBe(404);
        expect((err?.detail as any)?.responseBody).toBe(
            '{"error":"model_not_found"}',
        );
    });

    it('row31: an unexpected {error:...} RESOLVE (not a throw) still yields a well-formed RunState; erroring is via throw (row30)', async () => {
        // The AgentLoopResult contract is generateText's result; failure is a
        // THROW (row30), so the runner trusts a resolve. Assert it does not
        // crash on a bogus resolve shape and returns the declared type.
        const { state } = await runOnce({ result: { error: 'nope' } as any });
        assertWellFormed(state);
        expect(state.status).not.toBe('error'); // resolve is trusted, not a throw
    });

    it('row32: empty-success (usage only, no steps) → completed run with honest empty artifacts', async () => {
        const { state } = await runOnce({
            result: { usage: { inputTokens: 5, outputTokens: 0 }, steps: [] },
        });
        expect(state.status).toBe('completed');
        expect(state.artifacts).toEqual([]);
        expect(state.usage.inputTokens).toBe(5);
    });

    it('row33: refusal prose (no tool call) → completed, refusal text captured in steps, no artifact', async () => {
        const ev = {
            text: 'I cannot help with that request.',
            toolCalls: [],
            toolResults: [],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: 2, outputTokens: 3 },
        };
        const { state } = await runOnce({ events: [ev] });
        assertWellFormed(state);
        expect(state.artifacts).toEqual([]);
        expect(state.steps[0].message.content).toContain('I cannot help');
    });

    it('row33b: content-filter finish with an unexecuted tool call is surfaced as tool.skipped', async () => {
        const { state } = await runOnce({
            events: [
                toolCallEvent(
                    { text: 'x' },
                    {
                        name: 'echo',
                        finishReason: 'content-filter',
                        executed: false,
                    },
                ),
            ],
        });
        const skipped = state.trace.find((e) => e.kind === 'tool.skipped');
        expect(skipped).toBeDefined();
        expect((skipped?.detail as any)?.finishReason).toBe('content-filter');
    });

    it('row34: an aborted run — signal is threaded AND an abort throw becomes RunState{status:error}', async () => {
        const controller = new AbortController();
        controller.abort();
        const runCtx: ToolContext = {
            runId: 'abort-1',
            signal: controller.signal,
        };
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        const { state, req } = await runOnce({ runCtx, throwErr: abortErr });
        expect(req.signal).toBe(controller.signal); // threaded to LLM.run
        expect(state.status).toBe('error'); // fail-safe, not an uncaught throw
        const err = state.trace.find((e) => e.kind === 'error');
        expect(String(err?.detail?.name)).toContain('Abort');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// D. INPUT VARIANTS — feed the boundary; assert the assembly invariant holds.
// ───────────────────────────────────────────────────────────────────────────
describe('D. input variants — assembly invariants', () => {
    it('row35: empty input (empty prompt, no seed) → a single empty user message', async () => {
        const { req } = await runOnce({ input: { prompt: '' } });
        expect(req.messages).toEqual([{ role: 'user', content: '' }]);
    });

    it('row36: single seed message → seed then prompt', async () => {
        const { req } = await runOnce({
            input: {
                prompt: 'p',
                seedMessages: [{ role: 'user', content: 'one' }],
            },
        });
        expect(req.messages).toEqual([
            { role: 'user', content: 'one' },
            { role: 'user', content: 'p' },
        ]);
    });

    it('row38: duplicate seed messages are NOT silently deduped', async () => {
        const dup = { role: 'user' as const, content: 'same' };
        const { req } = await runOnce({
            input: { prompt: 'p', seedMessages: [dup, dup] },
        });
        expect(req.messages).toEqual([
            { role: 'user', content: 'same' },
            { role: 'user', content: 'same' },
            { role: 'user', content: 'p' },
        ]);
    });

    it('row39: null/undefined required fields do not crash assembly', async () => {
        // seedMessages omitted → defaulted; a seed with null content passes through.
        const noSeed = await runOnce({ input: { prompt: 'p' } as AgentRunInput });
        expect(noSeed.req.messages).toEqual([{ role: 'user', content: 'p' }]);
        const nullContent = await runOnce({
            input: {
                prompt: 'p',
                seedMessages: [{ role: 'user', content: null as any }],
            },
        });
        expect(nullContent.req.messages).toEqual([
            { role: 'user', content: null },
            { role: 'user', content: 'p' },
        ]);
    });

    it('row40: special chars / whitespace-only / huge diff prompt is threaded verbatim', async () => {
        const weird = '```\n\t🚀 <script> café   ' + 'x'.repeat(5000);
        const { req } = await runOnce({ input: { prompt: weird } });
        expect(req.messages[req.messages.length - 1]).toEqual({
            role: 'user',
            content: weird,
        });
    });

    it('row42: seed-order permutation is preserved 1:1 (no hidden reordering)', async () => {
        const a = { role: 'user' as const, content: 'A' };
        const b = { role: 'assistant' as const, content: 'B' };
        const ab = await runOnce({
            input: { prompt: 'p', seedMessages: [a, b] },
        });
        const ba = await runOnce({
            input: { prompt: 'p', seedMessages: [b, a] },
        });
        expect(ab.req.messages.map((m: any) => m.content)).toEqual([
            'A',
            'B',
            'p',
        ]);
        expect(ba.req.messages.map((m: any) => m.content)).toEqual([
            'B',
            'A',
            'p',
        ]);
    });

    it('D-invariant: a stray system-role seed is coerced to user (Gemini no-system rule)', async () => {
        const { req } = await runOnce({
            input: {
                prompt: 'p',
                seedMessages: [
                    { role: 'system' as any, content: 'you are a bot' },
                ],
            },
        });
        expect(
            (req.messages as any[]).some((m) => m.role === 'system'),
        ).toBe(false);
        expect(req.messages).toEqual([
            { role: 'user', content: 'you are a bot' },
            { role: 'user', content: 'p' },
        ]);
    });

    it('D-invariant: prepareStep never emits a system-role message either', async () => {
        // A policy that injects a full messages directive containing a system
        // turn must be sanitized by prepareStep before it reaches the model.
        const injectSystem: AgentPolicy = {
            name: 'inject-system',
            prepareStep: async () => ({
                messages: [
                    { role: 'system', content: 'sneaky system' },
                    { role: 'user', content: 'ok' },
                ],
            }),
        };
        const { req } = await runOnce({ spec: { policies: [injectSystem] } });
        const out = await req.loop.prepareStep({ stepNumber: 1, messages: [] });
        expect(Array.isArray(out.messages)).toBe(true);
        expect(
            (out.messages as any[]).some((m) => m.role === 'system'),
        ).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// RETURN-SHAPE GUARANTEE — the boundary ALWAYS returns its declared RunState,
// across the completed / stopped / budget-exhausted / error branches.
// ───────────────────────────────────────────────────────────────────────────
describe('return-shape guarantee (RunState across all branches)', () => {
    it('completed: no stop reason, steps under budget → status completed', async () => {
        const { state } = await runOnce({
            events: [toolCallEvent({ findings: [] })],
        });
        assertWellFormed(state);
        expect(state.status).toBe('completed');
        expect(state.runId).toBe('run-1');
        expect(state.agentId).toBe('finder');
    });

    it('stopped: a policy shouldStop fires → status stopped with the policy as stopReason', async () => {
        const stopper: AgentPolicy = {
            name: 'my-stopper',
            shouldStop: async () => true,
        };
        drive({ events: [] });
        const runner = new AiSdkAgentRunner(undefined);
        const spec = baseSpec({ policies: [stopper] });
        // The runner registers policyStopWhen; invoke it via the captured req.
        await runner.run(spec, { prompt: 'go' }, ctx);
        // Re-run so stopWhen is captured, then drive it to set stopReason.
        drive({
            events: [],
            result: { usage: {}, steps: [] },
        });
        // Build a fresh run whose stopWhen we call directly.
        mockRun.mockImplementation(async (req: any) => {
            capturedReq = req;
            await req.loop.stopWhen[0]({ steps: [] });
            return { usage: {}, steps: [] };
        });
        const state = await runner.run(spec, { prompt: 'go' }, ctx);
        expect(state.stopReason).toBe('my-stopper');
        expect(state.status).toBe('stopped');
    });

    it('budget-exhausted: steps reach maxSteps with no stop → status budget-exhausted', async () => {
        const { state } = await runOnce({
            spec: { maxSteps: 2, resultToolName: undefined },
            events: [
                toolCallEvent({}, { name: 'echo' }),
                toolCallEvent({}, { name: 'echo' }),
            ],
        });
        expect(state.steps.length).toBe(2);
        expect(state.status).toBe('budget-exhausted');
    });

    it('error: RunState carries the steps collected before the throw', async () => {
        // one step lands via onStepFinish, then LLM.run throws.
        mockRun.mockImplementation(async (req: any) => {
            await req.loop.onStepFinish(toolCallEvent({}, { name: 'echo' }));
            throw new Error('late boom');
        });
        const runner = new AiSdkAgentRunner(undefined);
        const state = await runner.run(baseSpec(), { prompt: 'go' }, ctx);
        expect(state.status).toBe('error');
        expect(state.steps.length).toBe(1);
        expect(state.usage).toBeDefined(); // aggregated best-effort from steps
    });

    it('usage: the completed run reports LLM.run result.usage via the single reader', async () => {
        const { state } = await runOnce({
            result: {
                usage: { inputTokens: 111, outputTokens: 22 },
                steps: [],
            },
        });
        expect(state.usage.inputTokens).toBe(111);
        expect(state.usage.outputTokens).toBe(22);
    });

    it('artifacts: with no resultToolName the run captures nothing (honest empty)', async () => {
        const { state } = await runOnce({
            spec: { resultToolName: undefined },
            events: [toolCallEvent({ findings: [1] })],
        });
        expect(state.artifacts).toEqual([]);
    });

    it('artifacts: the LAST result-tool call is the final structured output', async () => {
        const { state } = await runOnce({
            events: [
                toolCallEvent({ findings: ['first'] }),
                toolCallEvent({ findings: ['second'] }),
            ],
        });
        expect(state.artifacts).toHaveLength(2);
        expect(state.artifacts[1].payload).toEqual({ findings: ['second'] });
        expect(state.artifacts[1].location).toBe('step:1');
    });
});
