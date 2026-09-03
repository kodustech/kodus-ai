/**
 * CONTRACT tests for the LLM.run boundary in the review chain: `tracedGenerateText`.
 *
 * `tracedGenerateText` (llm-call.ts) is the low-level model-run wrapper every
 * review-chain LLM call goes through — `structured-review-call.ts:284` is its
 * consumer. Its DETERMINISTIC contract has three parts:
 *   1. Request assembly / threading — args (model, messages, schema, system,
 *      prompt, abortSignal, byokConfig-bearing options, telemetry) are forwarded
 *      to the AI SDK `generateText` VERBATIM. This module reshapes nothing.
 *   2. Output / envelope handling — it is a FAITHFUL PASSTHROUGH: whatever the
 *      model run resolves with (any shape, valid or off-schema) is returned
 *      byte-for-byte. Envelope parsing / repair / schema-coercion is delegated
 *      to higher layers (structured-output-gate.ts, structured-output-repair.ts)
 *      and is out of scope for this boundary — this boundary must NOT silently
 *      sanitize, drop, or coerce, because that would hide data from the layer
 *      whose job is to interpret it.
 *   3. Fail-safe + guaranteed shape — a hard-timeout net guarantees a maximum
 *      wall-clock time. This boundary is fail-LOUD by design: it PROPAGATES
 *      inner rejections and THROWS `[HARD-TIMEOUT]` when a provider hangs.
 *      Fallback-to-default lives in the calling stage, not here.
 *
 * Scope note: this file does NOT parse JSON, consult the structured-output
 * provider gate, or thread byokConfig into a request shape — those live in
 * sibling modules with their own contract specs. The matrix rows that only
 * apply to a parse/gate/batch boundary are recorded as N/A below with reasons.
 *
 * The boundary is spied at the REAL seam: `generateText` from the `ai` package
 * (which llm-call re-exports, timeout-wrapped, as `tracedGenerateText`).
 */

// Mock ONLY generateText; keep the rest of the `ai` package real.
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});

import { generateText } from 'ai';
import {
    tracedGenerateText,
    AGENT_TIMEOUT_MS,
    LLM_CALL_TIMEOUT_MS,
} from './llm-call';

const mockGenerate = generateText as unknown as jest.Mock;

// The boundary accepts the AI SDK CallSettings and returns the AI SDK result.
// We deliberately drive it with arbitrary shapes to prove faithful passthrough,
// so cast away the (irrelevant here) precise generic types.
const run = (opts: unknown): Promise<unknown> =>
    (tracedGenerateText as unknown as (o: unknown) => Promise<unknown>)(opts);

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Request assembly + threading (the "in" side)
// ---------------------------------------------------------------------------
describe('tracedGenerateText — request assembly + threading', () => {
    it('row 1 (happy path): forwards the exact options object to the model run and returns its result unchanged', async () => {
        const result = { text: 'ok', finishReason: 'stop' };
        mockGenerate.mockResolvedValueOnce(result);

        const opts = {
            model: { id: 'm' } as any,
            messages: [{ role: 'user', content: 'hi' }],
            system: 'you are a reviewer',
            abortSignal: undefined,
        };
        const out = await run(opts);

        // Exact side effect: called once, with the SAME options reference.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate.mock.calls[0][0]).toBe(opts);
        // Exact return: the wrapper returns the model result verbatim.
        expect(out).toBe(result);
    });

    it('threads a byokConfig-bearing options object through verbatim (no strip/mutate)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        // byokConfig / slot metadata rides along on the options; the wrapper
        // must not know or care about it — it forwards the whole object intact.
        const byokConfig = {
            provider: 'openai',
            model: 'gpt-4',
            apiKey: 'sk-secret',
            slot: { role: 'main' },
        };
        const opts = {
            model: {} as any,
            messages: [],
            byokConfig,
            experimental_output: { schema: { type: 'object' } },
        };

        await run(opts);

        const forwarded = mockGenerate.mock.calls[0][0];
        expect(forwarded).toBe(opts);
        // The threaded config survives untouched, key-for-key.
        expect(forwarded.byokConfig).toBe(byokConfig);
        expect(forwarded.byokConfig).toEqual(byokConfig);
        expect(forwarded.experimental_output).toBe(opts.experimental_output);
    });

    it('forwards ALL positional args, not just the first', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const a = { model: {} as any, messages: [] };
        const b = { extra: 'second-arg' };
        await (tracedGenerateText as unknown as (...xs: unknown[]) => Promise<unknown>)(a, b);
        expect(mockGenerate).toHaveBeenCalledWith(a, b);
    });

    it('returns a Promise (async boundary) for every call', () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const p = run({ model: {} as any });
        expect(typeof (p as any).then).toBe('function');
        return p; // settle it so no dangling
    });

    it('characterization: the internal __kodusHardTimeoutMs marker is currently forwarded to the SDK (not stripped)', async () => {
        // Documents observed behavior — the wrapper reads __kodusHardTimeoutMs
        // but forwards ...args unchanged, so the marker leaks into the SDK call.
        // The AI SDK ignores unknown settings, so this is a benign passthrough,
        // not a data-loss / wrong-answer degradation. Pinned so a future strip
        // is a conscious change.
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const opts = { model: {} as any, __kodusHardTimeoutMs: 12345 };
        await run(opts);
        expect(mockGenerate.mock.calls[0][0]).toHaveProperty(
            '__kodusHardTimeoutMs',
            12345,
        );
    });
});

// ---------------------------------------------------------------------------
// A. Output-shape zoo (rows 1-20) — faithful passthrough of any resolved shape.
//    This boundary parses/reshapes NOTHING, so the contract for every off-schema
//    shape is: return it byte-for-byte to the interpreting layer (never sanitize).
// ---------------------------------------------------------------------------
describe('tracedGenerateText — A: output-shape zoo returns verbatim (guaranteed shape = passthrough)', () => {
    const REF_D = { text: '{"keep":true}', finishReason: 'stop' };

    const cases: Array<[string, unknown]> = [
        ['row 2 — bare array where object expected', [{ a: 1 }, { a: 2 }]],
        ['row 3 — single object where array expected', { only: 1 }],
        ['row 4 — wrapper key {result:D}', { result: REF_D }],
        ['row 5 — double wrapper {result:{result:D}}', { result: { result: REF_D } }],
        ['row 6 — numeric/opaque single-key wrap {"0":D}', { '0': REF_D }],
        ['row 7 — stringified JSON payload', '{"keep":true}'],
        ['row 8 — markdown-fenced payload', '```json\n{"keep":true}\n```'],
        ['row 9 — prose-wrapped payload', 'Here is the result: {"keep":true}'],
        ['row 10 — right data, wrong keys', { duplicateGroups: [], uniqueIndices: [] }],
        ['row 11 — case/convention mismatch', { Keep: true, query_tasks: [] }],
        ['row 12 — partial object (some required keys missing)', { text: 'partial' }],
        ['row 13 — extra unknown keys alongside right ones', { text: 'x', __surprise: 1, nested: { z: 9 } }],
        ['row 14 — empty object', {}],
        ['row 15 — empty array', []],
        ['row 16 — empty string', ''],
        ['row 18 — primitive where object expected (boolean)', true],
        ['row 18b — primitive where object expected (number 0)', 0],
        ['row 18c — primitive where object expected (string "ok")', 'ok'],
        ['row 19 — provider envelope leak {choices:[{message:{content}}]}', { choices: [{ message: { content: '{"keep":true}' } }] }],
        ['row 20 — reasoning/thinking leak in content', { text: '<thinking>plan</thinking>{"keep":true}', reasoning: 'private chain' }],
    ];

    it.each(cases)('%s → returned unchanged (same reference)', async (_name, shape) => {
        mockGenerate.mockResolvedValueOnce(shape);
        const out = await run({ model: {} as any });
        // toBe: identity — the wrapper returns the exact object it received,
        // proving it neither parses, repairs, nor clones/sanitizes.
        expect(out).toBe(shape);
    });

    it('row 16b — whitespace-only string is preserved exactly (not trimmed to empty)', async () => {
        mockGenerate.mockResolvedValueOnce('   \n\t  ');
        const out = await run({ model: {} as any });
        expect(out).toBe('   \n\t  ');
    });

    it('row 17 — null resolved value passes through as null (no crash, no default)', async () => {
        mockGenerate.mockResolvedValueOnce(null);
        await expect(run({ model: {} as any })).resolves.toBeNull();
    });

    it('row 17b — undefined resolved value passes through as undefined', async () => {
        mockGenerate.mockResolvedValueOnce(undefined);
        await expect(run({ model: {} as any })).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// B. Semantic-but-wrong (rows 21-27) — valid JS, wrong value encoding.
//    Passthrough boundary does NOT coerce/validate → returns verbatim so the
//    interpreting layer sees the raw (wrong) encoding and can act on it.
// ---------------------------------------------------------------------------
describe('tracedGenerateText — B: semantic-but-wrong values pass through uncoerced', () => {
    const cases: Array<[string, unknown]> = [
        ['row 21 — boolean as string "true"', { keep: 'true' }],
        ['row 22 — boolean as yes/no', { keep: 'yes' }],
        ['row 23 — boolean as number 1', { keep: 1 }],
        ['row 24 — enum/severity out of allowed set', { severity: 'URGENT' }],
        ['row 25 — index out of range / dangling reference', { unique: [999] }],
        ['row 27 — unicode / escaped newlines / emoji in fields', { text: 'crçÃo 🚀 line1\\nline2  ' }],
    ];

    it.each(cases)('%s → returned unchanged (no coercion here; delegated)', async (_name, shape) => {
        mockGenerate.mockResolvedValueOnce(shape);
        const out = await run({ model: {} as any });
        expect(out).toBe(shape);
        expect(out).toEqual(shape);
    });
});

// ---------------------------------------------------------------------------
// C. Unparseable / transport (rows 28-34) — the fail-safe layer.
//    Contract of THIS boundary: fail-LOUD. Content strings pass through
//    verbatim (repair is elsewhere); rejections PROPAGATE; a hang is converted
//    to a [HARD-TIMEOUT] throw. It never silently swallows an error into a
//    fabricated success.
// ---------------------------------------------------------------------------
describe('tracedGenerateText — C: unparseable / transport / fail-safe', () => {
    it('row 28 — truncated JSON content passes through verbatim (no repair at this layer)', async () => {
        const truncated = { text: '{"keep":tr', finishReason: 'length' };
        mockGenerate.mockResolvedValueOnce(truncated);
        await expect(run({ model: {} as any })).resolves.toBe(truncated);
    });

    it('row 29 — malformed JSON content (trailing comma / single quotes) passes through verbatim', async () => {
        const malformed = { text: "{'keep': true,}" };
        mockGenerate.mockResolvedValueOnce(malformed);
        await expect(run({ model: {} as any })).resolves.toBe(malformed);
    });

    it('row 30 — LLM.run throws (network/timeout): propagates the SAME error, never a fake success', async () => {
        const boom = new Error('ECONNRESET');
        mockGenerate.mockRejectedValueOnce(boom);
        await expect(run({ model: {} as any })).rejects.toBe(boom);
    });

    it('row 31 — error OBJECT returned {error:...} is passed through verbatim (does NOT throw)', async () => {
        const errEnvelope = { error: { code: 'rate_limit', message: 'slow down' } };
        mockGenerate.mockResolvedValueOnce(errEnvelope);
        // The wrapper does not interpret {error} — it delivers it so the caller
        // can decide. It must NOT convert it into a throw or a default.
        await expect(run({ model: {} as any })).resolves.toBe(errEnvelope);
    });

    it('row 32 — empty success (content:"" finish_reason:"length") passes through verbatim', async () => {
        const empty = { text: '', finishReason: 'length' };
        mockGenerate.mockResolvedValueOnce(empty);
        await expect(run({ model: {} as any })).resolves.toBe(empty);
    });

    it('row 33 — refusal (finish_reason content_filter / "I cannot help") passes through verbatim', async () => {
        const refusal = { text: 'I cannot help with that.', finishReason: 'content-filter' };
        mockGenerate.mockResolvedValueOnce(refusal);
        await expect(run({ model: {} as any })).resolves.toBe(refusal);
    });

    it('row 34a — abortSignal is threaded to the model run verbatim', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const signal = new AbortController().signal;
        await run({ model: {} as any, abortSignal: signal });
        expect(mockGenerate.mock.calls[0][0].abortSignal).toBe(signal);
    });

    it('row 34b — an abort-triggered inner rejection propagates (not swallowed)', async () => {
        const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
        });
        mockGenerate.mockRejectedValueOnce(abortErr);
        await expect(
            run({ model: {} as any, abortSignal: new AbortController().signal }),
        ).rejects.toBe(abortErr);
    });
});

// ---------------------------------------------------------------------------
// C (timeout net) + timeout-policy branches — fake timers.
//    This is the boundary's OWN policy branching: which wall-clock cap applies.
//    Observed via the [HARD-TIMEOUT] message ("exceeded Ns") when the provider
//    ignores the abort signal and hangs forever.
// ---------------------------------------------------------------------------
describe('tracedGenerateText — hard-timeout net + wall-clock policy branches', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    const hang = () => new Promise<never>(() => {});

    it('no abortSignal, no override → AGENT_TIMEOUT_MS branch (4800s) throws [HARD-TIMEOUT]', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({ model: {} as any }).catch((e) => e);
        jest.advanceTimersByTime(AGENT_TIMEOUT_MS + 5_001);
        const err = (await p) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('[HARD-TIMEOUT]');
        expect(err.message).toContain('4800s');
    });

    it('abortSignal present → LLM_CALL_TIMEOUT_MS branch (1200s), the shorter secondary-call cap', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({
            model: {} as any,
            abortSignal: new AbortController().signal,
        }).catch((e) => e);
        jest.advanceTimersByTime(LLM_CALL_TIMEOUT_MS + 5_001);
        const err = (await p) as Error;
        expect(err.message).toContain('[HARD-TIMEOUT]');
        expect(err.message).toContain('1200s');
    });

    it('__kodusHardTimeoutMs override wins (explicit cap honored)', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({ model: {} as any, __kodusHardTimeoutMs: 20_000 }).catch(
            (e) => e,
        );
        jest.advanceTimersByTime(20_000 + 5_001);
        const err = (await p) as Error;
        expect(err.message).toContain('[HARD-TIMEOUT]');
        expect(err.message).toContain('20s');
    });

    it('metamorphic (row 42) — __kodusHardTimeoutMs takes PRECEDENCE over abortSignal regardless of both being present', async () => {
        // Same inputs, override present alongside abortSignal → override branch
        // wins deterministically (not the 1200s abort branch).
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({
            model: {} as any,
            abortSignal: new AbortController().signal,
            __kodusHardTimeoutMs: 20_000,
        }).catch((e) => e);
        jest.advanceTimersByTime(20_000 + 5_001);
        const err = (await p) as Error;
        expect(err.message).toContain('20s');
        expect(err.message).not.toContain('1200s');
    });

    it('label branch: telemetry.functionId is used in the timeout message', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({
            model: {} as any,
            __kodusHardTimeoutMs: 1_000,
            telemetry: { functionId: 'review:finder' },
        }).catch((e) => e);
        jest.advanceTimersByTime(6_002);
        expect(((await p) as Error).message).toContain('review:finder');
    });

    it('label branch: experimental_telemetry.functionId is the fallback', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({
            model: {} as any,
            __kodusHardTimeoutMs: 1_000,
            experimental_telemetry: { functionId: 'review:verify' },
        }).catch((e) => e);
        jest.advanceTimersByTime(6_002);
        expect(((await p) as Error).message).toContain('review:verify');
    });

    it('label branch: defaults to "generateText" when no telemetry is provided', async () => {
        mockGenerate.mockReturnValueOnce(hang());
        const p = run({ model: {} as any, __kodusHardTimeoutMs: 1_000 }).catch(
            (e) => e,
        );
        jest.advanceTimersByTime(6_002);
        expect(((await p) as Error).message).toContain('generateText');
    });

    it('a call that settles before the cap resolves with the inner value (net does not fire)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'fast' });
        await expect(
            run({ model: {} as any, __kodusHardTimeoutMs: 60_000 }),
        ).resolves.toEqual({ text: 'fast' });
    });
});

// ---------------------------------------------------------------------------
// D. Input variants (rows 35-42) — the options object is the "input".
// ---------------------------------------------------------------------------
describe('tracedGenerateText — D: input variants', () => {
    it('row 35 — empty options ({}): defaults label to "generateText" and forwards {} verbatim', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const opts = {};
        await run(opts);
        expect(mockGenerate.mock.calls[0][0]).toBe(opts);
    });

    it('row 36 — a single minimal options object is forwarded and its result returned', async () => {
        const res = { text: 'single' };
        mockGenerate.mockResolvedValueOnce(res);
        await expect(run({ model: {} as any })).resolves.toBe(res);
    });

    it('row 39 — null/undefined optional fields fall back cleanly (no crash on ?./|| guards)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        // abortSignal + telemetry explicitly undefined → default ms + default label
        await expect(
            run({
                model: {} as any,
                abortSignal: undefined,
                telemetry: undefined,
                experimental_telemetry: undefined,
            }),
        ).resolves.toEqual({ text: 'x' });
    });

    it('row 39b — a fully null/undefined opts does not throw synchronously (defensive optional chaining)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        // opts?.__kodusHardTimeoutMs / opts?.abortSignal / opts?.telemetry all
        // guard against a nullish options object.
        await expect(run(undefined)).resolves.toEqual({ text: 'x' });
    });

    it('row 40 — special chars / whitespace label survive into the timeout message', async () => {
        jest.useFakeTimers();
        try {
            mockGenerate.mockReturnValueOnce(new Promise<never>(() => {}));
            const weird = 'rëview:🚀\tstep\n<x>';
            const p = run({
                model: {} as any,
                __kodusHardTimeoutMs: 1_000,
                telemetry: { functionId: weird },
            }).catch((e) => e);
            jest.advanceTimersByTime(6_002);
            expect(((await p) as Error).message).toContain(weird);
        } finally {
            jest.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariant — the boundary ALWAYS returns exactly what the model
// run returned across every resolved-value layer (the #1786 non-degradation
// guarantee for a passthrough: never keep-all / drop / default silently).
// ---------------------------------------------------------------------------
describe('tracedGenerateText — guaranteed return shape is exact passthrough across all layers', () => {
    const shapes: Array<[string, unknown]> = [
        ['object', { text: 'a', usage: { total: 1 } }],
        ['array', [1, 2, 3]],
        ['string', 'raw'],
        ['empty object', {}],
        ['null', null],
    ];
    it.each(shapes)('resolves with the identical %s the model run produced', async (_n, shape) => {
        mockGenerate.mockResolvedValueOnce(shape);
        const out = await run({ model: {} as any });
        expect(out).toStrictEqual(shape as any);
    });

    it('does not invoke the model run more than once per call', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        await run({ model: {} as any });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });
});
