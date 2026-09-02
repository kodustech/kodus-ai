/**
 * llm.spec.ts — the `LLM.run` WIRING of runtime model failover (the seam between
 * a slot's `.fallback` and the executor cascade). The executors, the classifier
 * and the logger are mocked so these tests pin only what `run` is responsible for:
 *   - build the attempts `[slot, slot.fallback]` and inject each as `byokConfig`;
 *   - cascade one-shot calls to the fallback on a cascade-worthy failure;
 *   - guard the agent loop so a step that already ran vetoes the cascade.
 * The cascade decision itself lives in `model-failover.spec.ts`.
 */
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Control the cascade decision by category carried on the error (`__cat`) and the
// abort veto by `__abort`. Categories the real `model-failover` switches on are all
// defined so an error's `__cat` maps to the same branch a real classifier would.
jest.mock('@libs/llm/error-classifier', () => ({
    LlmErrorCategory: {
        TRANSIENT: 'TRANSIENT',
        UNKNOWN: 'UNKNOWN',
        RATE_LIMIT: 'RATE_LIMIT',
        CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
        AUTH_INVALID: 'AUTH_INVALID',
    },
    classifyLLMError: (e: any) => ({ category: e?.__cat ?? 'UNKNOWN' }),
    isTerminalCategory: (c: string) => c === 'AUTH_INVALID',
    isAbortOrHardTimeout: (e: any) => !!e?.__abort,
}));

const runStructuredReviewCall = jest.fn();
const runTextReviewCall = jest.fn();
const runAgentLoopCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (p: unknown) => runStructuredReviewCall(p),
    runTextReviewCall: (p: unknown) => runTextReviewCall(p),
}));
jest.mock('@libs/llm/agent-loop-call', () => ({
    runAgentLoopCall: (p: unknown) => runAgentLoopCall(p),
}));

// Routing branch of `resolveSlot`: mocked so the `{ config, task }` path is
// deterministic and its arguments are observable. The `byokConfig` path never
// touches it (asserted below).
const resolveTaskSlot = jest.fn();
jest.mock('./resolve-task-model', () => ({
    resolveTaskSlot: (...a: unknown[]) => resolveTaskSlot(...a),
}));

import { LLM } from './llm';
import type { NormalizedModel } from './byok-config';

const authErr = () => Object.assign(new Error('unauth'), { __cat: 'AUTH_INVALID' });
const transientErr = () =>
    Object.assign(new Error('5xx'), { __cat: 'TRANSIENT' });
const unknownErr = (msg = 'boom') =>
    Object.assign(new Error(msg), { __cat: 'UNKNOWN' });
const abortErr = () =>
    Object.assign(new Error('aborted'), { __cat: 'TRANSIENT', __abort: true });

const slotWithFallback: NormalizedModel = {
    model: 'primary',
    byokModelId: 'p',
    provider: 'openai',
    apiKey: 'enc',
    fallback: {
        model: 'fallback',
        byokModelId: 'f',
        provider: 'openai',
        apiKey: 'enc',
    },
} as any;

const bareSlot: NormalizedModel = {
    model: 'solo',
    byokModelId: 's',
    provider: 'openai',
    apiKey: 'enc',
} as any;

// A fake schema so the STRUCTURED overload is taken; the executor is mocked, so
// its parse fn is never exercised here (parsing is structured-review-call's job).
const passSchema = { parse: (v: unknown) => v } as any;

beforeEach(() => {
    jest.clearAllMocks();
    runStructuredReviewCall.mockReset();
    runTextReviewCall.mockReset();
    runAgentLoopCall.mockReset();
    resolveTaskSlot.mockReset();
});

describe('LLM.run — one-shot failover wiring', () => {
    it('cascades to slot.fallback on a cascade-worthy failure', async () => {
        runTextReviewCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce('from-fallback');

        const out = await LLM.run({
            byokConfig: slotWithFallback,
            user: 'hi',
            runName: 'r',
        });

        expect(out).toBe('from-fallback');
        expect(runTextReviewCall).toHaveBeenCalledTimes(2);
        // primary then fallback, each injected as byokConfig
        expect(runTextReviewCall.mock.calls[0][0].byokConfig.model).toBe('primary');
        expect(runTextReviewCall.mock.calls[1][0].byokConfig.model).toBe('fallback');
    });

    it('does not cascade when there is no fallback on the slot', async () => {
        runTextReviewCall.mockRejectedValue(authErr());
        const bare: NormalizedModel = {
            model: 'solo',
            byokModelId: 's',
            provider: 'openai',
            apiKey: 'enc',
        } as any;

        await expect(
            LLM.run({ byokConfig: bare, user: 'hi', runName: 'r' }),
        ).rejects.toThrow('unauth');
        expect(runTextReviewCall).toHaveBeenCalledTimes(1);
    });

    it('routes a structured call through the same cascade', async () => {
        runStructuredReviewCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce({ ok: true });

        const out = await LLM.run({
            byokConfig: slotWithFallback,
            user: 'hi',
            runName: 'r',
            schema: { parse: (v: unknown) => v } as any,
        });

        expect(out).toEqual({ ok: true });
        expect(runStructuredReviewCall).toHaveBeenCalledTimes(2);
    });
});

describe('LLM.run — agent-loop failover guard', () => {
    const loopReq = {
        byokConfig: slotWithFallback,
        runName: 'r',
        messages: [],
        loop: { tools: {}, maxSteps: 5 },
    };

    it('cascades when the loop fails BEFORE any step (clean restart)', async () => {
        runAgentLoopCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce('loop-fallback');

        const out = await LLM.run(loopReq as any);

        expect(out).toBe('loop-fallback');
        expect(runAgentLoopCall).toHaveBeenCalledTimes(2);
    });

    it('does NOT cascade once a step has emitted (unsafe to restart)', async () => {
        // Simulate a step running (fires onStepFinish) before the failure — the
        // guard must veto the cascade so runner state is not double-counted.
        runAgentLoopCall.mockImplementationOnce((params: any) => {
            params.loop.onStepFinish?.({ step: 1 });
            return Promise.reject(authErr());
        });

        await expect(LLM.run(loopReq as any)).rejects.toThrow('unauth');
        expect(runAgentLoopCall).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// I/O CONTRACT MATRIX (see scratchpad/llm-io-contract-matrix.md).
//
// SCOPE NOTE for THIS boundary. `LLM.run` is a FACADE: it does not parse model
// envelopes — that is `structured-review-call.ts` / `structured-output-repair.ts`
// (covered by their own specs, and the parse layer is where the #1786 recovery /
// json_object gate lives). By the time a value reaches `LLM.run` the executor has
// ALREADY recovered it or thrown. So the facade's slice of the contract is:
//   • A/B rows (output-shape zoo / semantic-but-wrong): return the executor's
//     value VERBATIM — never silently transform, clone, drop, or default it. A
//     wrong shape shipping is the executor's row; the facade must not ADD a silent
//     degradation of its own. Asserted as byte-identical passthrough.
//   • C rows (transport / fail-safe): a throw from the executor must fail-safe
//     via the failover cascade and NEVER be swallowed into a silent success.
//   • D rows (input variants): the request's user/system/messages/slot are
//     threaded to the executor unchanged (no reorder, no dedup, no drop).
//   • E dimension (N-model gate): the json_schema-vs-json_object branch is chosen
//     downstream from `slot.provider`; the facade's job is to thread the slot
//     (provider intact) to the executor for BOTH a strict-prefix and a
//     fallback-prefix provider. The branch itself is delegated → rowsNA.
// ─────────────────────────────────────────────────────────────────────────────

describe('LLM.run — output passthrough, no silent transform [matrix A/B/C-resolved]', () => {
    // Object / array / primitive shapes go through the STRUCTURED entry; the
    // facade must return exactly what the executor resolved (reference identity).
    const objectShapes: Array<[string, unknown]> = [
        ['row 1  exact D', { groups: [], unique: [] }],
        ['row 2  bare array where D is object', [{ a: 1 }]],
        ['row 3  single object where D is array', { a: 1 }],
        ['row 4  wrapper key {result:D}', { result: { groups: [] } }],
        ['row 5  double wrapper {result:{result:D}}', { result: { result: {} } }],
        ['row 6  numeric single-key wrap {"0":D}', { '0': { groups: [] } }],
        ['row 10 right data wrong keys', { duplicateGroups: [], uniqueIndices: [] }],
        ['row 11 case/convention mismatch', { Keep: true }],
        ['row 12 partial object', { groups: [] }],
        ['row 13 extra unknown keys', { groups: [], unique: [], extra: 1 }],
        ['row 14 empty object', {}],
        ['row 15 empty array', []],
        ['row 18 primitive where object expected (true)', true],
        ['row 18 primitive where object expected (0)', 0],
        ['row 18 primitive where object expected ("ok")', 'ok'],
        ['row 19 provider envelope leak', { choices: [{ message: { content: '{}' } }] }],
        ['row 20 reasoning/thinking leak in content', { content: '<thinking>x</thinking>{}' }],
        ['row 21 boolean as string', { keep: 'true' }],
        ['row 22 boolean as yes/no', { keep: 'yes' }],
        ['row 23 boolean as number', { keep: 1 }],
        ['row 24 enum out of allowed set', { severity: 'URGENT' }],
        ['row 25 index out of range / dangling ref', { unique: [999] }],
        ['row 26 duplicate JSON keys (post-parse last-wins)', { keep: false }],
        ['row 27 unicode / escaped newlines / emoji', { msg: 'héllo\n🚀' }],
        ['row 31 error object returned {error:...}', { error: 'boom' }],
    ];

    it.each(objectShapes)(
        'structured: returns %s verbatim (identity, no facade transform)',
        async (_label, value) => {
            runStructuredReviewCall.mockResolvedValueOnce(value);
            const out = await LLM.run({
                byokConfig: bareSlot,
                user: 'u',
                runName: 'r',
                schema: passSchema,
            });
            expect(out).toBe(value);
            expect(runStructuredReviewCall).toHaveBeenCalledTimes(1);
            // The text executor must never fire for a schema call.
            expect(runTextReviewCall).not.toHaveBeenCalled();
        },
    );

    it('row 17: passes a null executor result through unchanged (no substitution)', async () => {
        runStructuredReviewCall.mockResolvedValueOnce(null);
        await expect(
            LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r', schema: passSchema }),
        ).resolves.toBeNull();
    });

    it('row 17: passes an undefined executor result through unchanged', async () => {
        runStructuredReviewCall.mockResolvedValueOnce(undefined);
        await expect(
            LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r', schema: passSchema }),
        ).resolves.toBeUndefined();
    });

    // String shapes go through the TEXT entry; the raw string is returned verbatim.
    const stringShapes: Array<[string, string]> = [
        ['row 7  stringified JSON', '{"groups":[]}'],
        ['row 8  markdown-fenced', '```json\n{}\n```'],
        ['row 9  prose-wrapped', 'Here is the result: {}'],
        ['row 16 empty string', ''],
        ['row 16 whitespace-only', '   \n\t'],
        ['row 32 empty success (finish_reason=length)', ''],
        ['row 33 refusal prose', 'I cannot help with that.'],
    ];

    it.each(stringShapes)(
        'text: returns %s verbatim (no trim, no default)',
        async (_label, value) => {
            runTextReviewCall.mockResolvedValueOnce(value);
            const out = await LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r' });
            expect(out).toBe(value);
            expect(runTextReviewCall).toHaveBeenCalledTimes(1);
            expect(runStructuredReviewCall).not.toHaveBeenCalled();
        },
    );
});

describe('LLM.run — transport / fail-safe [matrix C]', () => {
    it('row 28 truncated JSON: executor throw propagates, never a silent default', async () => {
        runStructuredReviewCall.mockRejectedValueOnce(
            unknownErr('Unexpected end of JSON input'),
        );
        await expect(
            LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r', schema: passSchema }),
        ).rejects.toThrow('Unexpected end of JSON input');
        expect(runStructuredReviewCall).toHaveBeenCalledTimes(1);
    });

    it('row 29 malformed JSON: executor throw propagates (UNKNOWN not cascaded)', async () => {
        runStructuredReviewCall.mockRejectedValue(unknownErr('trailing comma'));
        await expect(
            LLM.run({
                byokConfig: slotWithFallback,
                user: 'u',
                runName: 'r',
                schema: passSchema,
            }),
        ).rejects.toThrow('trailing comma');
        // UNKNOWN is not cascade-worthy → the fallback is NOT tried, and the error
        // is not swallowed into a silent success.
        expect(runStructuredReviewCall).toHaveBeenCalledTimes(1);
    });

    it('row 30 network/transient WITH fallback: fails over, returns the fallback result', async () => {
        runTextReviewCall
            .mockRejectedValueOnce(transientErr())
            .mockResolvedValueOnce('from-fallback');
        const out = await LLM.run({
            byokConfig: slotWithFallback,
            user: 'u',
            runName: 'r',
        });
        expect(out).toBe('from-fallback');
        expect(runTextReviewCall).toHaveBeenCalledTimes(2);
    });

    it('row 30 network/transient WITHOUT fallback: propagates (no silent empty string)', async () => {
        runTextReviewCall.mockRejectedValue(transientErr());
        await expect(
            LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r' }),
        ).rejects.toThrow('5xx');
        expect(runTextReviewCall).toHaveBeenCalledTimes(1);
    });

    it('row 31 {error} returned (not thrown): returned verbatim, boundary does not throw', async () => {
        // Covered as passthrough above too; asserted here as an explicit fail-safe
        // contract — a non-throwing error envelope is a resolved value, not a crash.
        runTextReviewCall.mockResolvedValueOnce('{"error":"boom"}');
        await expect(
            LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r' }),
        ).resolves.toBe('{"error":"boom"}');
    });

    it('row 34 abort signal fired: NOT cascaded even with a fallback, error propagates', async () => {
        runTextReviewCall.mockRejectedValue(abortErr());
        await expect(
            LLM.run({ byokConfig: slotWithFallback, user: 'u', runName: 'r' }),
        ).rejects.toThrow('aborted');
        // isAbortOrHardTimeout vetoes failover → the fallback model is not burned.
        expect(runTextReviewCall).toHaveBeenCalledTimes(1);
    });

    it('row 34 abort on the agent-loop path also propagates without cascade', async () => {
        runAgentLoopCall.mockRejectedValue(abortErr());
        await expect(
            LLM.run({
                byokConfig: slotWithFallback,
                runName: 'r',
                messages: [],
                loop: { tools: {}, maxSteps: 3 },
            } as any),
        ).rejects.toThrow('aborted');
        expect(runAgentLoopCall).toHaveBeenCalledTimes(1);
    });
});

describe('LLM.run — slot resolution + request assembly [threading]', () => {
    it('byokConfig wins: an explicit slot is used and resolveTaskSlot is NOT called', async () => {
        runTextReviewCall.mockResolvedValueOnce('ok');
        await LLM.run({
            byokConfig: bareSlot,
            config: { anything: true } as any,
            task: 'code_review' as any,
            user: 'u',
            runName: 'r',
        });
        expect(resolveTaskSlot).not.toHaveBeenCalled();
        expect(runTextReviewCall.mock.calls[0][0].byokConfig).toBe(bareSlot);
    });

    it('routes via {config, task}: resolveTaskSlot(config, task, {ctx}) → its slot is injected', async () => {
        const routed = { model: 'routed', provider: 'openai' } as any;
        resolveTaskSlot.mockReturnValue({ slot: routed, verdict: {} });
        runTextReviewCall.mockResolvedValueOnce('ok');
        const config = { v: 2 } as any;
        const ctx = { repo: 'x' } as any;

        await LLM.run({
            config,
            task: 'code_review' as any,
            ctx,
            user: 'u',
            runName: 'r',
        });

        expect(resolveTaskSlot).toHaveBeenCalledWith(config, 'code_review', { ctx });
        expect(runTextReviewCall.mock.calls[0][0].byokConfig).toBe(routed);
    });

    it('row 39 null/undefined slot: no byokConfig and no config → managed default (undefined), no throw', async () => {
        runTextReviewCall.mockResolvedValueOnce('managed');
        const out = await LLM.run({ user: 'u', runName: 'r' });
        expect(out).toBe('managed');
        expect(resolveTaskSlot).not.toHaveBeenCalled();
        expect(runTextReviewCall.mock.calls[0][0].byokConfig).toBeUndefined();
    });

    it('strips routing/loop-only fields from the one-shot executor params', async () => {
        runTextReviewCall.mockResolvedValueOnce('ok');
        await LLM.run({
            byokConfig: bareSlot,
            user: 'u',
            runName: 'r',
            config: { v: 2 } as any,
            task: 'code_review' as any,
            ctx: { repo: 'x' } as any,
            reporter: () => undefined,
            signal: new AbortController().signal,
            temperature: 0.4,
            maxOutputTokens: 1024,
            providerOptions: { reasoning: { effort: 'high' } },
        } as any);

        const params = runTextReviewCall.mock.calls[0][0];
        // Routing / loop-only fields must NOT reach the one-shot executor.
        for (const stripped of ['config', 'task', 'ctx', 'reporter', 'signal', 'loop', 'messages']) {
            expect(params).not.toHaveProperty(stripped);
        }
        // Injected slot + fixed-tuning overrides DO pass through.
        expect(params.byokConfig).toBe(bareSlot);
        expect(params.temperature).toBe(0.4);
        expect(params.maxOutputTokens).toBe(1024);
        expect(params.providerOptions).toEqual({ reasoning: { effort: 'high' } });
    });

    it('structured call carries the schema; text call carries none', async () => {
        runStructuredReviewCall.mockResolvedValueOnce({});
        await LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r', schema: passSchema });
        expect(runStructuredReviewCall.mock.calls[0][0].schema).toBe(passSchema);

        runTextReviewCall.mockResolvedValueOnce('ok');
        await LLM.run({ byokConfig: bareSlot, user: 'u', runName: 'r' });
        expect(runTextReviewCall.mock.calls[0][0]).not.toHaveProperty('schema');
    });
});

describe('LLM.run — input variants threaded verbatim [matrix D]', () => {
    it('row 35 empty input: user="" is forwarded, not defaulted', async () => {
        runTextReviewCall.mockResolvedValueOnce('ok');
        await LLM.run({ byokConfig: bareSlot, user: '', runName: 'r' });
        expect(runTextReviewCall.mock.calls[0][0].user).toBe('');
    });

    it('row 35 empty input: loop messages=[] forwarded unchanged', async () => {
        runAgentLoopCall.mockResolvedValueOnce({ text: '' });
        await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages: [],
            loop: { tools: {}, maxSteps: 3 },
        } as any);
        expect(runAgentLoopCall.mock.calls[0][0].messages).toEqual([]);
    });

    it('row 36 single item: a one-message conversation is forwarded as-is', async () => {
        runAgentLoopCall.mockResolvedValueOnce({ text: 'x' });
        const messages = [{ role: 'user', content: 'hi' }] as any;
        await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages,
            loop: { tools: {}, maxSteps: 3 },
        } as any);
        expect(runAgentLoopCall.mock.calls[0][0].messages).toBe(messages);
    });

    it('row 38 duplicate items: the facade does NOT dedup the messages', async () => {
        runAgentLoopCall.mockResolvedValueOnce({ text: 'x' });
        const m = { role: 'user', content: 'dup' } as any;
        await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages: [m, m],
            loop: { tools: {}, maxSteps: 3 },
        } as any);
        expect(runAgentLoopCall.mock.calls[0][0].messages).toEqual([m, m]);
    });

    it('row 40 special chars / whitespace: the user turn is forwarded byte-for-byte', async () => {
        runTextReviewCall.mockResolvedValueOnce('ok');
        const user = '  \n\tdiff --git a/💥 b/💥\r\n<script>   ';
        await LLM.run({ byokConfig: bareSlot, user, runName: 'r' });
        expect(runTextReviewCall.mock.calls[0][0].user).toBe(user);
    });

    it('row 42 order permutation: message order is preserved (no reorder)', async () => {
        runAgentLoopCall.mockResolvedValueOnce({ text: 'x' });
        const a = { role: 'user', content: 'a' } as any;
        const b = { role: 'user', content: 'b' } as any;
        await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages: [b, a],
            loop: { tools: {}, maxSteps: 3 },
        } as any);
        expect(runAgentLoopCall.mock.calls[0][0].messages).toEqual([b, a]);
    });
});

describe('LLM.run — provider threading for the downstream gate [matrix E, delegated]', () => {
    // The json_schema-vs-json_object gate is chosen downstream from slot.provider
    // (structured-output-gate / mayUseJsonSchema). The facade's only duty is to
    // thread the slot — provider intact — to the executor, for BOTH branches.
    it.each([
        ['strict json_schema prefix', 'openai'],
        ['strict json_schema prefix', 'anthropic'],
        ['strict json_schema prefix', 'google'],
        ['strict json_schema prefix', 'moonshotai'],
        ['json_object fallback prefix', 'kimi'],
        ['json_object fallback prefix', 'glm'],
        ['json_object fallback prefix', 'deepseek'],
        ['json_object fallback prefix', 'z-ai'],
    ])('threads slot.provider (%s: %s) to the executor unchanged', async (_kind, provider) => {
        runStructuredReviewCall.mockResolvedValueOnce({});
        const slot = { model: 'm', provider, apiKey: 'enc' } as any;
        await LLM.run({ byokConfig: slot, user: 'u', runName: 'r', schema: passSchema });
        expect(runStructuredReviewCall.mock.calls[0][0].byokConfig.provider).toBe(provider);
    });
});

describe('LLM.run — loop assembly + guaranteed return shape', () => {
    it('threads every loop seam + tuning field to runAgentLoopCall with the per-attempt slot', async () => {
        runAgentLoopCall.mockResolvedValueOnce({ text: 'done', steps: [], usage: {} });
        const signal = new AbortController().signal;
        const reporter = jest.fn();
        const providerOptions = { anthropic: { thinking: { type: 'enabled' } } };
        const telemetryMetadata = { organizationId: 'org' } as any;
        const loop = { tools: { t: {} }, maxSteps: 7, stopWhen: [] } as any;

        await LLM.run({
            byokConfig: bareSlot,
            system: 'sys',
            messages: [{ role: 'user', content: 'go' }] as any,
            loop,
            runName: 'r',
            spanName: 'span',
            attrs: { phase: 'p' },
            organizationId: 'org',
            reporter,
            queueTimeoutMs: 5000,
            provider: 'openai',
            providerOptions,
            telemetryMetadata,
            signal,
            maxOutputTokens: 2048,
            temperature: 0.2,
        } as any);

        const p = runAgentLoopCall.mock.calls[0][0];
        expect(p.byokConfig).toBe(bareSlot);
        expect(p.system).toBe('sys');
        expect(p.spanName).toBe('span');
        expect(p.attrs).toEqual({ phase: 'p' });
        expect(p.organizationId).toBe('org');
        expect(p.reporter).toBe(reporter);
        expect(p.queueTimeoutMs).toBe(5000);
        expect(p.provider).toBe('openai');
        expect(p.providerOptions).toBe(providerOptions);
        expect(p.telemetryMetadata).toBe(telemetryMetadata);
        expect(p.signal).toBe(signal);
        expect(p.maxOutputTokens).toBe(2048);
        expect(p.temperature).toBe(0.2);
    });

    it('wraps loop.onStepFinish so the inner hook still runs (and its return propagates)', async () => {
        const inner = jest.fn().mockReturnValue('inner-return');
        let wrappedReturn: unknown;
        runAgentLoopCall.mockImplementationOnce((params: any) => {
            wrappedReturn = params.loop.onStepFinish?.({ step: 1 });
            return Promise.resolve({ text: 'ok' });
        });

        await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages: [],
            loop: { tools: {}, maxSteps: 3, onStepFinish: inner },
        } as any);

        expect(inner).toHaveBeenCalledWith({ step: 1 });
        expect(wrappedReturn).toBe('inner-return');
    });

    it('returns the raw AgentLoopResult verbatim (guaranteed loop return shape)', async () => {
        const result = { text: 'answer', steps: [{ n: 1 }], usage: { total: 5 } };
        runAgentLoopCall.mockResolvedValueOnce(result);
        const out = await LLM.run({
            byokConfig: bareSlot,
            runName: 'r',
            messages: [],
            loop: { tools: {}, maxSteps: 3 },
        } as any);
        expect(out).toBe(result);
    });
});
