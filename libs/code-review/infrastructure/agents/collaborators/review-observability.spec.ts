/**
 * Contract tests for the review-observability trace boundary
 * (`runAgentWithTrace`).
 *
 * This boundary does NOT call `LLM.run` itself (usage/cost spans live at the
 * leaf model call — see the file header). It wraps `fn` — the leaf that may run
 * the model — in a Langfuse trace span. Its I/O contract is therefore TWO
 * deterministic guarantees, and those are all that is in scope here:
 *
 *   1. Transparency: whatever `fn` resolves to is returned byte-identical, in
 *      both the tracing-on and tracing-off branches, for EVERY return shape —
 *      the wrapper never parses, re-keys, unwraps, or defaults the payload.
 *      (Recovering an off-schema envelope is the leaf's job, not this wrapper's;
 *      identity IS the correct behavior here, so the shape zoo is asserted as
 *      pass-through, not as recover-or-signal.)
 *   2. Trace-metadata assembly: `meta` -> the exact `propagateAttributes`
 *      config (org/team defaults, prNumber/pullRequestId stringing, repo
 *      threading, sessionId derivation, userId).
 *
 * The model's decision QUALITY is out of scope (separate eval track).
 *
 * Matrix mapping (rows 1-42) is annotated per test; the non-applicable rows and
 * the one known degradation are recorded in the structured result.
 *
 * We mock only `@langfuse/tracing` (as the sibling langfuse-trace.spec does) so
 * the real `shouldTrace` / `pullRequestSessionId` derivation runs. The mock
 * captures the propagate config, the observation name, and the span.update
 * arguments, and can be told to make span.update throw (to probe the documented
 * "observability must never break a review" fail-safe).
 */

const mockState: {
    propagate: any[];
    observationNames: string[];
    spanUpdateArgs: any[];
    spanUpdateThrows: Error | null;
} = {
    propagate: [],
    observationNames: [],
    spanUpdateArgs: [],
    spanUpdateThrows: null,
};

jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        mockState.propagate.push(params);
        return fn();
    },
    startActiveObservation: (name: string, cb: (span: any) => unknown) => {
        mockState.observationNames.push(name);
        const span = {
            update: (arg: any) => {
                mockState.spanUpdateArgs.push(arg);
                if (mockState.spanUpdateThrows) {
                    throw mockState.spanUpdateThrows;
                }
            },
        };
        return cb(span);
    },
}));

import { runAgentWithTrace } from './review-observability';

const originalEnv = { ...process.env };

function enableTracing() {
    process.env.LANGFUSE_TRACING = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
}

function disableTracing() {
    delete process.env.LANGFUSE_TRACING;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockState.propagate = [];
    mockState.observationNames = [];
    mockState.spanUpdateArgs = [];
    mockState.spanUpdateThrows = null;
});

afterEach(() => {
    process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// A. Output-shape zoo (rows 1-20) + B row 27 + C rows 31-33
//
// The wrapper is payload-agnostic: for every shape `fn` can resolve to, it must
// return the SAME reference/value unchanged, hand that exact value to
// span.update({output}), and never throw. We run each shape through BOTH the
// tracing-off and tracing-on branches so the identity guarantee holds
// regardless of the span machinery.
// ---------------------------------------------------------------------------

type ZooCase = { row: string; name: string; value: unknown };

const shapeZoo: ZooCase[] = [
    // Row 1 — exact declared shape (happy path). The "declared shape" of this
    // boundary is just T; a well-formed finder envelope stands in for it.
    { row: '1', name: 'exact declared payload', value: { findings: [{ id: 'f1' }], summary: 'ok' } },
    // Row 2 — bare array where an object is the usual payload.
    { row: '2', name: 'bare array of inner items', value: [{ id: 'f1' }, { id: 'f2' }] },
    // Row 3 — single object where an array is usual (and vice-versa is row 2).
    { row: '3', name: 'single object where array expected', value: { id: 'only' } },
    // Row 4 — wrapper key envelopes.
    { row: '4', name: 'wrapper key {result}', value: { result: { findings: [] } } },
    { row: '4', name: 'wrapper key {data}', value: { data: { findings: [] } } },
    { row: '4', name: 'wrapper key {output}', value: { output: { findings: [] } } },
    { row: '4', name: 'wrapper key {response}', value: { response: { findings: [] } } },
    { row: '4', name: 'wrapper key {json}', value: { json: { findings: [] } } },
    // Row 5 — double wrapper.
    { row: '5', name: 'double wrapper {result:{result}}', value: { result: { result: { findings: [] } } } },
    // Row 6 — numeric / opaque single-key wrap.
    { row: '6', name: 'numeric single-key wrap {"0"}', value: { '0': { findings: [] } } },
    { row: '6', name: 'content single-key wrap', value: { content: { findings: [] } } },
    // Row 7 — stringified JSON payload.
    { row: '7', name: 'stringified JSON', value: '{"findings":[]}' },
    // Row 8 — markdown-fenced JSON string.
    { row: '8', name: 'markdown-fenced JSON', value: '```json\n{"findings":[]}\n```' },
    // Row 9 — prose-wrapped JSON string.
    { row: '9', name: 'prose-wrapped JSON', value: 'Here is the result: {"findings":[]}\n\nLet me know.' },
    // Row 10 — right data, wrong (renamed) keys.
    { row: '10', name: 'renamed keys', value: { duplicateGroups: [], uniqueIndices: [0] } },
    // Row 11 — case / convention mismatch.
    { row: '11', name: 'snake_case vs camelCase', value: { query_tasks: [], Keep: true } },
    // Row 12 — partial object (some required keys missing).
    { row: '12', name: 'partial object', value: { findings: [] } },
    // Row 13 — extra unknown keys alongside the right ones.
    { row: '13', name: 'extra unknown keys', value: { findings: [], summary: 'ok', __debug: 'x', extra: 1 } },
    // Row 14 — empty object.
    { row: '14', name: 'empty object', value: {} },
    // Row 15 — empty array.
    { row: '15', name: 'empty array', value: [] },
    // Row 16 — empty / whitespace-only string.
    { row: '16', name: 'empty string', value: '' },
    { row: '16', name: 'whitespace-only string', value: '   \n\t ' },
    // Row 17 — null / undefined return.
    { row: '17', name: 'null', value: null },
    { row: '17', name: 'undefined', value: undefined },
    // Row 18 — primitive where object expected.
    { row: '18', name: 'boolean primitive', value: true },
    { row: '18', name: 'zero primitive', value: 0 },
    { row: '18', name: 'string primitive', value: 'ok' },
    // Row 19 — provider envelope leak.
    { row: '19', name: 'chat-completions envelope leak', value: { choices: [{ message: { content: '{"findings":[]}' } }] } },
    { row: '19', name: 'tool_call arguments-as-string leak', value: { tool_calls: [{ function: { arguments: '{"findings":[]}' } }] } },
    // Row 20 — reasoning / thinking leak in content.
    { row: '20', name: 'thinking-without-signature leak', value: { thinking: 'let me consider...', findings: [] } },
    // Row 27 (B) — unicode / escaped newlines / emoji inside string fields.
    { row: '27', name: 'unicode + emoji + escaped newlines', value: { summary: 'café   line\\nbreak 🚀', findings: [] } },
    // Row 31 (C) — error object returned instead of thrown.
    { row: '31', name: 'error object {error} returned', value: { error: { code: 'E_MODEL', message: 'boom' } } },
    // Row 32 (C) — empty success (content:'' / finish_reason length).
    { row: '32', name: 'empty-success envelope', value: { content: '', finish_reason: 'length' } },
    // Row 33 (C) — refusal prose.
    { row: '33', name: 'refusal prose', value: 'I cannot help with that request.' },
];

describe('runAgentWithTrace — return-shape transparency (rows 1-20, 27, 31-33)', () => {
    const baseMeta = { traceName: 'code-review-finder' };

    describe('tracing DISABLED (pure passthrough, no span touched)', () => {
        beforeEach(disableTracing);

        it.each(shapeZoo)(
            'row $row: returns $name unchanged and opens no span',
            async ({ value }) => {
                const result = await runAgentWithTrace(baseMeta, { in: 1 }, async () => value);

                // Identity: exact same value/reference back out.
                expect(result).toBe(value as any);
                // No degradation path was entered at all.
                expect(mockState.propagate).toHaveLength(0);
                expect(mockState.observationNames).toHaveLength(0);
            },
        );
    });

    describe('tracing ENABLED (span opened, payload still untouched)', () => {
        beforeEach(enableTracing);

        it.each(shapeZoo)(
            'row $row: returns $name unchanged and records it verbatim on the span',
            async ({ value }) => {
                const result = await runAgentWithTrace(baseMeta, { in: 1 }, async () => value);

                // Identity survives the span wrapping.
                expect(result).toBe(value as any);
                // The span recorded the input first, then the exact output value
                // — no unwrap, no re-key, no default.
                expect(mockState.observationNames).toEqual(['code-review-finder']);
                expect(mockState.spanUpdateArgs).toHaveLength(2);
                expect(mockState.spanUpdateArgs[0]).toEqual({ input: { in: 1 } });
                expect(mockState.spanUpdateArgs[1].output).toBe(value as any);
            },
        );
    });
});

// ---------------------------------------------------------------------------
// C. Fail-safe / transport (rows 30, 34, and the documented swallow contract)
// ---------------------------------------------------------------------------

describe('runAgentWithTrace — fail-safe behavior (rows 30, 34 + observability swallow)', () => {
    const baseMeta = { traceName: 'code-review-finder' };

    describe('with tracing disabled', () => {
        beforeEach(disableTracing);

        // Row 30 — the leaf (LLM.run) throws: the review error is the caller's
        // real signal and MUST propagate unchanged, not be masked.
        it('row 30: propagates a leaf failure (does not swallow the review error)', async () => {
            const err = new Error('model network timeout');
            await expect(
                runAgentWithTrace(baseMeta, {}, async () => {
                    throw err;
                }),
            ).rejects.toBe(err);
        });

        // Row 34 — abort fired mid-call: surfaces as fn rejecting; propagates.
        it('row 34: propagates an AbortError from the leaf', async () => {
            const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
            await expect(
                runAgentWithTrace(baseMeta, {}, async () => {
                    throw abort;
                }),
            ).rejects.toMatchObject({ name: 'AbortError' });
        });
    });

    describe('with tracing enabled', () => {
        beforeEach(enableTracing);

        // Row 30 (traced branch) — leaf failure still propagates through the span.
        it('row 30: propagates a leaf failure through the open span', async () => {
            const err = new Error('model 500');
            await expect(
                runAgentWithTrace(baseMeta, {}, async () => {
                    throw err;
                }),
            ).rejects.toBe(err);
            // The input was recorded, but the failure was not turned into a
            // silent success.
            expect(mockState.spanUpdateArgs[0]).toEqual({ input: {} });
        });

        // Row 34 (traced branch).
        it('row 34: propagates an AbortError through the open span', async () => {
            const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
            await expect(
                runAgentWithTrace(baseMeta, {}, async () => {
                    throw abort;
                }),
            ).rejects.toMatchObject({ name: 'AbortError' });
        });

        // KNOWN DEGRADATION (documented-behavior violation, #1786 class).
        //
        // The file header (review-observability.ts:8) promises: "Best-effort:
        // any failure is swallowed (observability must never break a review)."
        // But the startActiveObservation callback (review-observability.ts:60-65)
        // has NO try/catch, so a Langfuse span.update failure escapes the
        // boundary and destroys an otherwise-successful review result. The
        // matrix fail-safe rule (row-C class: "never throw past the boundary")
        // is violated for observability-internal errors.
        //
        // Pinned as it.failing = the CORRECT behavior (swallow the span error,
        // still return the review result). Green today (it throws), turns RED
        // the moment a try/catch is added around the span work.
        it.failing(
            'observability swallow: a span.update failure must NOT break the review (review-observability.ts:60)',
            async () => {
                mockState.spanUpdateThrows = new Error('langfuse export failed');

                const result = await runAgentWithTrace(
                    baseMeta,
                    {},
                    async () => 'review-result',
                );

                expect(result).toBe('review-result');
            },
        );
    });
});

// ---------------------------------------------------------------------------
// D. Input variants (rows 35, 36, 39, 40) + deterministic metadata assembly
// ---------------------------------------------------------------------------

describe('runAgentWithTrace — trace-metadata assembly (rows 35, 36, 39, 40)', () => {
    beforeEach(enableTracing);

    // Row 39 — required identity fields absent: fixed placeholders, never the
    // string "undefined", and userId mirrors org.
    it('row 39: defaults absent org/team to fixed placeholders and mirrors userId', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder' },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.metadata.organizationId).toBe('unknown_org');
        expect(cfg.metadata.teamId).toBe('unknown_team');
        expect(cfg.userId).toBe('unknown_org');
        // No PR -> no session invented, and prNumber/pullRequestId omitted.
        expect(cfg.sessionId).toBeUndefined();
        expect(cfg.metadata.prNumber).toBeUndefined();
        expect(cfg.metadata.pullRequestId).toBeUndefined();
        expect(cfg.metadata.repositoryId).toBeUndefined();
    });

    it('threads a full meta into the propagate config and derives the session key', async () => {
        await runAgentWithTrace(
            {
                traceName: 'code-review-verify',
                organizationId: 'org-1',
                teamId: 'team-9',
                prNumber: 42,
                repositoryId: 'repo-7',
            },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.traceName).toBe('code-review-verify');
        expect(cfg.userId).toBe('org-1');
        expect(cfg.metadata).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-9',
            prNumber: '42', // stringified
            pullRequestId: '42', // stringified alias
            repositoryId: 'repo-7',
        });
        // Session key derives from the SAME helper every agent shares.
        expect(cfg.sessionId).toBe('org-1:repo-7:42');
    });

    it('omits prNumber/pullRequestId and the session when prNumber is falsy (PR 0 is "no PR")', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder', organizationId: 'org-1', prNumber: 0 },
            {},
            async () => 'ok',
        );

        const cfg = mockState.propagate[0];
        expect(cfg.metadata.prNumber).toBeUndefined();
        expect(cfg.metadata.pullRequestId).toBeUndefined();
        expect(cfg.sessionId).toBeUndefined();
    });

    it('derives the session with a repo placeholder when only org+pr are known', async () => {
        await runAgentWithTrace(
            { traceName: 'code-review-finder', organizationId: 'org-1', prNumber: 7 },
            {},
            async () => 'ok',
        );

        expect(mockState.propagate[0].sessionId).toBe('org-1:repo:7');
        expect(mockState.propagate[0].metadata.repositoryId).toBeUndefined();
    });

    // Row 35 — empty input (nothing to record on the span).
    it('row 35: empty/undefined spanInput is recorded as-is and the result returns', async () => {
        const result = await runAgentWithTrace(
            { traceName: 'code-review-finder' },
            undefined,
            async () => 'done',
        );

        expect(result).toBe('done');
        expect(mockState.spanUpdateArgs[0]).toEqual({ input: undefined });
    });

    // Row 36 — single item input.
    it('row 36: a single-item spanInput is recorded verbatim', async () => {
        const single = { file: 'a.ts' };
        await runAgentWithTrace(
            { traceName: 'code-review-finder' },
            single,
            async () => 'ok',
        );

        expect(mockState.spanUpdateArgs[0].input).toBe(single);
    });

    // Row 40 — special chars / whitespace / large-ish payload in the recorded
    // input must pass straight through without mangling the result.
    it('row 40: special-char / whitespace spanInput passes through untouched', async () => {
        const gnarly = {
            diff: '\t  \n emoji 🚀   café <script>alert(1)</script> ',
            note: '   ',
        };
        const result = await runAgentWithTrace(
            { traceName: 'code-review-finder' },
            gnarly,
            async () => 'ok',
        );

        expect(result).toBe('ok');
        expect(mockState.spanUpdateArgs[0].input).toBe(gnarly);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the boundary ALWAYS returns fn's resolved value across layers.
// ---------------------------------------------------------------------------

describe('runAgentWithTrace — declared return type is honored in both branches', () => {
    it('disabled branch resolves to exactly the fn value', async () => {
        disableTracing();
        const payload = { findings: [{ id: 'x' }] };
        await expect(
            runAgentWithTrace({ traceName: 't' }, {}, async () => payload),
        ).resolves.toBe(payload);
    });

    it('enabled branch resolves to exactly the fn value', async () => {
        enableTracing();
        const payload = { findings: [{ id: 'x' }] };
        await expect(
            runAgentWithTrace({ traceName: 't' }, {}, async () => payload),
        ).resolves.toBe(payload);
    });
});
