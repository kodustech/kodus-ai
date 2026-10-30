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
 * sibling modules with their own contract specs.
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

// The boundary accepts the AI SDK CallSettings and returns the AI SDK result;
// cast away the (irrelevant here) precise generic types.
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

    it('forwards ALL positional args, not just the first', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        const a = { model: {} as any, messages: [] };
        const b = { extra: 'second-arg' };
        await (
            tracedGenerateText as unknown as (
                ...xs: unknown[]
            ) => Promise<unknown>
        )(a, b);
        expect(mockGenerate).toHaveBeenCalledWith(a, b);
    });

    it('a rejection propagates the SAME error, never a fake success', async () => {
        const boom = new Error('ECONNRESET');
        mockGenerate.mockRejectedValueOnce(boom);
        await expect(run({ model: {} as any })).rejects.toBe(boom);
    });

    it('a nullish options object does not throw synchronously (defensive optional chaining)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x' });
        // opts?.__kodusHardTimeoutMs / opts?.abortSignal / opts?.telemetry all
        // guard against a nullish options object.
        await expect(run(undefined)).resolves.toEqual({ text: 'x' });
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
