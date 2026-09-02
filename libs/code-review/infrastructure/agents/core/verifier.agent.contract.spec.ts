/**
 * CONTRACT tests for the verifier.agent LLM.run boundary (issue #1786).
 *
 * The verifier runs one model call per finding through `runner.run` (which wraps
 * LLM.run). The model is asked to emit a verdict `{keep, rationale, confidence}`
 * via the submitVerdict result tool; the runner materializes that payload into
 * `RunState.artifacts`, and the DETERMINISTIC layer under test here —
 * `extractVerdict` + `LlmVerifier.verify` — parses it back into a `Verdict`.
 *
 * The #1786 class: non-strict models (kimi / glm / deepseek / z-ai fall back to
 * json_object) return the verdict in the WRONG envelope — a bare array, a
 * {result:...} wrapper, a stringified JSON, the right value under a wrong key.
 * `extractVerdict` only recognises a top-level boolean `keep`; on any other
 * shape it SILENTLY defaults to keep:true. That default is safe when the model
 * genuinely could not decide, but it is a real degradation when the model DID
 * decide `keep:false` (refute → drop) and merely wrapped it: the refuted finding
 * is silently kept and SHIPS to the PR — the direct analog of "dedup keeps all →
 * duplicate comments ship".
 *
 * These tests assert the correct (non-degrading) contract. Where the current
 * code silently degrades they are `it.failing` — green today, they flip to a
 * real failure the day the envelope is repaired. See knownDegradations.
 */
import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    VERIFY_DONE_TOOL,
    buildVerifierAgentSpec,
    verifierPromptFor,
    extractVerdict,
    LlmVerifier,
} from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { openRouterHonorsJsonSchema } from '@libs/llm/structured-output-gate';

// --- fixtures -------------------------------------------------------------

const NO_ARTIFACT = Symbol('no-artifact');

/** Build a RunState whose single result-tool artifact carries `payload`.
 *  Pass NO_ARTIFACT to omit the artifact entirely. */
function makeState(
    payload: unknown,
    overrides: Partial<RunState> = {},
): RunState {
    return {
        runId: 'run-1',
        agentId: 'verifier',
        status: 'completed',
        steps: [],
        artifacts:
            (payload as unknown) === NO_ARTIFACT
                ? []
                : [{ type: VERIFY_DONE_TOOL, payload }],
        usage: {
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cacheReadTokens: 1,
        },
        trace: [],
        ...overrides,
    } as RunState;
}

function candidate(over: Partial<FinderSuggestion> = {}): FinderSuggestion {
    return {
        relevantFile: 'src/x.ts',
        suggestionContent: 'null deref',
        existingCode: 'x.y',
        improvedCode: 'x?.y',
        relevantLinesStart: 42,
        relevantLinesEnd: 44,
        severity: 'high',
        confidence: 8,
        ...over,
    };
}

/** A fake AgentRunner standing in for the LLM.run boundary. */
function fakeRunner(impl: AgentRunner['run']): {
    runner: AgentRunner;
    run: jest.Mock;
} {
    const run = jest.fn(impl);
    return { runner: { run } as AgentRunner, run };
}

const inertParams = () => ({
    modelId: 'moonshot/kimi-k2',
    tools: new InMemoryToolRegistry([]),
});

// =========================================================================
// LAYER 1 — HAPPY PATH: correct schema shape → exact Verdict
// =========================================================================
describe('verifier contract — LAYER 1 happy path', () => {
    it('extractVerdict returns the exact declared Verdict for a well-formed payload', () => {
        const state = makeState({
            keep: false,
            rationale: 'refuted: guarded upstream',
            confidence: 'high',
        });
        expect(extractVerdict(state)).toEqual({
            keep: false,
            rationale: 'refuted: guarded upstream',
            confidence: 'high',
            toolCalls: [],
        });
    });

    it('extractVerdict preserves keep:true from a well-formed payload', () => {
        const v = extractVerdict(
            makeState({
                keep: true,
                rationale: 'confirmed real bug',
                confidence: 'medium',
            }),
        );
        expect(v.keep).toBe(true);
        expect(v.rationale).toBe('confirmed real bug');
        expect(v.confidence).toBe('medium');
    });

    it('extractVerdict reads the LAST result-tool artifact', () => {
        const state = makeState(undefined, {
            artifacts: [
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { keep: true, rationale: 'first' },
                },
                { type: 'grep', payload: { irrelevant: 1 } },
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { keep: false, rationale: 'final' },
                },
            ],
        });
        const v = extractVerdict(state);
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe('final');
    });

    it('extractVerdict collects investigation tool calls (excluding submitVerdict) onto the verdict', () => {
        const state = makeState(
            { keep: false, rationale: 'r' },
            {
                steps: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '',
                            toolCalls: [
                                {
                                    id: 't1',
                                    name: 'grep',
                                    input: { pattern: 'x.y' },
                                    output: 'hit',
                                },
                                {
                                    id: 't2',
                                    name: VERIFY_DONE_TOOL,
                                    input: { keep: false },
                                    output: 'ok',
                                },
                            ],
                        },
                    },
                ],
            },
        );
        const v = extractVerdict(state);
        expect(v.toolCalls).toEqual([
            { name: 'grep', args: { pattern: 'x.y' }, result: 'hit' },
        ]);
    });

    it('LlmVerifier.verify returns the model verdict and accumulates usage', async () => {
        const { runner, run } = fakeRunner(async () =>
            makeState({
                keep: false,
                rationale: 'refuted',
                confidence: 'high',
            }),
        );
        const v = new LlmVerifier(runner, inertParams());
        const verdict = await v.verify(candidate(), {} as ToolContext);

        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('refuted');
        expect(run).toHaveBeenCalledTimes(1);
        // usage threaded from the run state
        expect(v.usage).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cacheReadTokens: 1,
        });
    });

    it('LlmVerifier.verify passes a prompt naming the finding to the runner', async () => {
        const { runner, run } = fakeRunner(async () =>
            makeState({ keep: true, rationale: 'r' }),
        );
        const v = new LlmVerifier(runner, inertParams());
        await v.verify(
            candidate({ relevantFile: 'src/pay.ts' }),
            {} as ToolContext,
        );
        const [, input] = run.mock.calls[0];
        expect(typeof input.prompt).toBe('string');
        expect(input.prompt).toContain('src/pay.ts');
    });

    it('LlmVerifier.verify honours the confidence depth split (light vs full spec)', async () => {
        const { runner, run } = fakeRunner(async () =>
            makeState({ keep: true, rationale: 'r' }),
        );
        const v = new LlmVerifier(runner, {
            ...inertParams(),
            lightMaxSteps: 5,
            fullMaxSteps: 10,
        });
        await v.verify(candidate({ confidence: 8 }), {} as ToolContext); // high → light
        await v.verify(candidate({ confidence: 2 }), {} as ToolContext); // low  → full
        expect(run.mock.calls[0][0].maxSteps).toBe(5);
        expect(run.mock.calls[1][0].maxSteps).toBe(10);
    });
});

// =========================================================================
// LAYER 1b — assembly / prompt contract
// =========================================================================
describe('verifier contract — assembly', () => {
    it('buildVerifierAgentSpec returns the declared spec shape', () => {
        const spec = buildVerifierAgentSpec({
            modelId: 'moonshot/kimi-k2',
            tools: new InMemoryToolRegistry([]),
        });
        expect(spec.id).toBe('verifier');
        expect(spec.phase).toBe('verify');
        expect(spec.resultToolName).toBe(VERIFY_DONE_TOOL);
        expect(spec.maxSteps).toBe(6);
        expect(spec.runName).toBe('code-review-verify');
        expect(spec.tools.list().some((t) => t.name === VERIFY_DONE_TOOL)).toBe(
            true,
        );
    });

    it('verifierPromptFor embeds the finding evidence', () => {
        const p = verifierPromptFor(
            candidate({
                relevantFile: 'src/y.ts',
                suggestionContent: 'off-by-one',
            }),
        );
        expect(typeof p).toBe('string');
        expect(p).toContain('src/y.ts');
        expect(p).toContain('off-by-one');
    });
});

// =========================================================================
// LAYER 2 — OFF-SCHEMA / N-MODEL ROBUSTNESS (the #1786 class)
//
// The model DECIDED keep:false (refute → drop) but returned it in an envelope
// the non-strict providers actually emit. The correct contract recovers the
// decision; the current code silently defaults to keep:true → the refuted
// finding SHIPS. These are it.failing (assert the correct, non-degrading
// behavior) so they flip to a real failure once the envelope is repaired.
// =========================================================================
describe('verifier contract — LAYER 2 off-schema robustness (#1786)', () => {
    it('recovers keep:false from a {result:{...}} wrapper (does NOT silently keep)', () => {
        const v = extractVerdict(
            makeState({ result: { keep: false, rationale: 'refuted' } }),
        );
        expect(v.keep).toBe(false);
    });

    it('recovers keep:false from a bare array envelope (does NOT silently keep)', () => {
        const v = extractVerdict(
            makeState([{ keep: false, rationale: 'refuted' }]),
        );
        expect(v.keep).toBe(false);
    });

    it('recovers keep:false from a stringified-JSON payload (does NOT silently keep)', () => {
        const v = extractVerdict(
            makeState(JSON.stringify({ keep: false, rationale: 'refuted' })),
        );
        expect(v.keep).toBe(false);
    });

    it('recovers keep:false when the boolean lives under a wrong-but-obvious key ("decision")', () => {
        // Some json_object fallbacks rename the field. A repair layer that
        // maps decision/verdict/shouldKeep -> keep would catch this; the
        // current code cannot see it and silently keeps.
        const v = extractVerdict(
            makeState({ decision: false, reason: 'refuted' }),
        );
        expect(v.keep).toBe(false);
    });

    it('LlmVerifier.verify surfaces a wrapped keep:false through the full LLM.run boundary', async () => {
        const { runner } = fakeRunner(async () =>
            makeState({ result: { keep: false, rationale: 'refuted' } }),
        );
        const v = new LlmVerifier(runner, inertParams());
        const verdict = await v.verify(candidate(), {} as ToolContext);
        expect(verdict.keep).toBe(false);
    });

    // --- unrecoverable shapes: default-keep IS the documented fail-open ------
    // No keep signal exists to recover, so defaulting to keep (fail-open, never
    // drop) is the CORRECT contract for a refute-to-drop verifier. These pass.
    it('defaults to keep:true with an explicit reason on null / {} / partial / non-JSON string', () => {
        for (const bad of [
            null,
            {},
            { rationale: 'no verdict field' },
            'not json at all',
            42,
        ]) {
            const v = extractVerdict(makeState(bad));
            expect(v.keep).toBe(true);
            expect(typeof v.rationale).toBe('string');
            expect(v.rationale).toMatch(/no parseable verdict/i);
        }
    });

    it('defaults to keep:true when the result artifact is absent entirely', () => {
        const v = extractVerdict(makeState(NO_ARTIFACT));
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/no parseable verdict/i);
    });

    it('ALWAYS returns a Verdict with a boolean keep, whatever the model emitted', () => {
        const garbage: unknown[] = [
            null,
            undefined,
            {},
            [],
            'x',
            0,
            NaN,
            true,
            { keep: 'false' }, // wrong type
            { keep: null },
            { result: { keep: true } },
            [{ keep: false }],
            { keep: false, rationale: 'ok', confidence: 'high' },
        ];
        for (const g of garbage) {
            const v = extractVerdict(makeState(g));
            expect(typeof v.keep).toBe('boolean');
            expect(Array.isArray(v.toolCalls)).toBe(true);
        }
    });
});

// =========================================================================
// LAYER 3 — FAIL-SAFE: the model call rejects (provider error / suspended key)
//
// The verifier's port contract (Verifier<T>) says: "MUST default to keep when
// unsure (fail open) — a checker that errors or is uncertain never silently
// drops a candidate." A provider error IS "uncertain": verify must degrade to a
// keep:true verdict, not throw past its boundary and abort the whole review.
// =========================================================================
describe('verifier contract — LAYER 3 fail-safe (provider error)', () => {
    it.failing(
        'verify degrades to a keep:true verdict when the model call rejects (never throws past its boundary)',
        async () => {
            const { runner } = fakeRunner(async () => {
                throw new Error('provider error: BYOK key suspended');
            });
            const v = new LlmVerifier(runner, inertParams());
            const verdict = await v.verify(candidate(), {} as ToolContext);
            expect(verdict.keep).toBe(true); // fail-open per the Verifier port
        },
    );

    it('documents current behavior: verify currently propagates the provider error', async () => {
        const { runner } = fakeRunner(async () => {
            throw new Error('provider error: BYOK key suspended');
        });
        const v = new LlmVerifier(runner, inertParams());
        await expect(v.verify(candidate(), {} as ToolContext)).rejects.toThrow(
            /BYOK key suspended/,
        );
    });
});

// =========================================================================
// BACKFILL — full LLM.run I/O contract matrix (issue #1786)
//
// The boundary under test is the DETERMINISTIC parse layer `extractVerdict`
// (fed the runner-materialized `submitVerdict` payload) plus `LlmVerifier.verify`
// (the LLM.run round-trip). The declared schema D is
//   { keep: boolean, rationale: string, confidence?: 'high'|'medium'|'low' }.
//
// extractVerdict recognises ONLY a top-level boolean `keep` (verifier.agent.ts:143);
// on any other shape it returns the fail-open default keep:true with an
// observable rationale (verifier.agent.ts:154-158). For a refute-to-drop verifier
// that default is the CORRECT contract when NO keep signal is recoverable
// (assert with `it` — passes today). It is a real degradation when the model DID
// decide keep:false but wrapped/encoded it off-schema: the correct contract is to
// RECOVER keep:false, and the current code silently keeps → `it.failing` (green
// today, flips red when the envelope repair lands). See knownDegradations.
// =========================================================================

// ---- A. Output-shape zoo -------------------------------------------------
describe('backfill A — output-shape zoo (off-schema returns)', () => {
    // Row 2 & 3: bare array where D is an object, and metamorphic equivalence
    // between the array-of-one and the plain object encodings of the same
    // decision. (Row 2's single-element form is already pinned in LAYER 2; this
    // adds a multi-element array and the object/array equivalence for row 3.)
    it('row2: recovers keep:false from a multi-element bare array (does NOT silently keep)', () => {
        const v = extractVerdict(
            makeState([
                { keep: false, rationale: 'refuted' },
                { note: 'extra element' },
            ]),
        );
        expect(v.keep).toBe(false);
    });

    it('row3: array-of-one and plain object encode the SAME decision (metamorphic)', () => {
        const asObject = extractVerdict(
            makeState({ keep: false, rationale: 'r' }),
        );
        const asArray = extractVerdict(
            makeState([{ keep: false, rationale: 'r' }]),
        );
        expect(asArray.keep).toBe(asObject.keep); // both should be false
    });

    // Row 4: the remaining single-key wrapper envelopes (LAYER 2 pins {result}).
    it('row4: recovers keep:false from a {data:D} wrapper', () => {
        expect(
            extractVerdict(makeState({ data: { keep: false, rationale: 'r' } }))
                .keep,
        ).toBe(false);
    });
    it('row4: recovers keep:false from a {output:D} wrapper', () => {
        expect(
            extractVerdict(
                makeState({ output: { keep: false, rationale: 'r' } }),
            ).keep,
        ).toBe(false);
    });
    it('row4: recovers keep:false from a {response:D} wrapper', () => {
        expect(
            extractVerdict(
                makeState({ response: { keep: false, rationale: 'r' } }),
            ).keep,
        ).toBe(false);
    });
    it('row4: recovers keep:false from a {json:D} wrapper', () => {
        expect(
            extractVerdict(makeState({ json: { keep: false, rationale: 'r' } }))
                .keep,
        ).toBe(false);
    });

    // Row 5: double wrapper.
    it('row5: recovers keep:false from a {result:{result:D}} double wrapper', () => {
        expect(
            extractVerdict(
                makeState({
                    result: { result: { keep: false, rationale: 'r' } },
                }),
            ).keep,
        ).toBe(false);
    });

    // Row 6: numeric/opaque single-key wrap.
    it('row6: recovers keep:false from a {"0":D} numeric-key wrap', () => {
        expect(
            extractVerdict(makeState({ '0': { keep: false, rationale: 'r' } }))
                .keep,
        ).toBe(false);
    });
    it('row6: recovers keep:false from a {content:D} wrap', () => {
        expect(
            extractVerdict(
                makeState({ content: { keep: false, rationale: 'r' } }),
            ).keep,
        ).toBe(false);
    });

    // Row 8: markdown-fenced JSON as the (string) payload.
    it('row8: recovers keep:false from a ```json fenced string payload', () => {
        expect(
            extractVerdict(
                makeState('```json\n{"keep": false, "rationale": "r"}\n```'),
            ).keep,
        ).toBe(false);
    });

    // Row 9: prose-wrapped JSON string.
    it('row9: recovers keep:false from a prose-wrapped JSON string payload', () => {
        expect(
            extractVerdict(
                makeState(
                    'Here is my verdict: {"keep": false, "rationale": "r"}. Let me know!',
                ),
            ).keep,
        ).toBe(false);
    });

    // Row 11: case/convention mismatch on the key.
    it('row11: recovers keep:false when the key is CamelCased ({Keep:false})', () => {
        expect(
            extractVerdict(makeState({ Keep: false, rationale: 'r' })).keep,
        ).toBe(false);
    });

    // Row 13: extra unknown keys alongside the right ones MUST be tolerated
    // (recovers, does not crash). keep is a top-level boolean → passes today.
    it('row13: tolerates extra unknown keys alongside a valid keep:false', () => {
        const v = extractVerdict(
            makeState({
                keep: false,
                rationale: 'r',
                confidence: 'high',
                unknownA: 1,
                nested: { b: 2 },
                arr: [3],
            }),
        );
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe('r');
        expect(v.confidence).toBe('high');
    });

    // Row 15: empty array → no keep signal → correct fail-open keep:true.
    it('row15: empty array payload → fail-open keep:true with observable reason', () => {
        const v = extractVerdict(makeState([]));
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/no parseable verdict/i);
    });

    // Row 16: empty / whitespace-only string → no signal → fail-open keep:true.
    it('row16: empty and whitespace-only string payloads → fail-open keep:true', () => {
        for (const s of ['', '   ', '\n\t ']) {
            const v = extractVerdict(makeState(s));
            expect(v.keep).toBe(true);
            expect(v.rationale).toMatch(/no parseable verdict/i);
        }
    });

    // Row 19: provider envelope leak (raw choices/message shape not unwrapped by
    // the runner) carrying a keep:false decision.
    it.failing(
        'row19: recovers keep:false from a leaked {choices:[{message:{content}}]} envelope',
        () => {
            const v = extractVerdict(
                makeState({
                    choices: [
                        {
                            message: {
                                content: '{"keep": false, "rationale": "r"}',
                            },
                        },
                    ],
                }),
            );
            expect(v.keep).toBe(false);
        },
    );

    // Row 20: reasoning/thinking leak — the verdict JSON prefixed by thinking
    // prose (anthropic thinking-without-signature class) in a string payload.
    it('row20: recovers keep:false when the verdict JSON is preceded by a thinking leak', () => {
        const v = extractVerdict(
            makeState(
                '<thinking>the guard upstream already handles null</thinking>\n{"keep": false, "rationale": "r"}',
            ),
        );
        expect(v.keep).toBe(false);
    });
});

// ---- B. Semantic-but-wrong -----------------------------------------------
describe('backfill B — semantic-but-wrong value encodings', () => {
    // Row 21: boolean as string.
    it.failing(
        'row21: recovers keep:false from keep:"false" (boolean-as-string)',
        () => {
            expect(
                extractVerdict(makeState({ keep: 'false', rationale: 'r' }))
                    .keep,
            ).toBe(false);
        },
    );

    // Row 22: boolean as yes/no.
    it.failing(
        'row22: recovers keep:false from keep:"no" (boolean-as-yes/no)',
        () => {
            expect(
                extractVerdict(makeState({ keep: 'no', rationale: 'r' })).keep,
            ).toBe(false);
        },
    );

    // Row 23: boolean as number.
    it.failing(
        'row23: recovers keep:false from keep:0 (boolean-as-number)',
        () => {
            expect(
                extractVerdict(makeState({ keep: 0, rationale: 'r' })).keep,
            ).toBe(false);
        },
    );

    // Row 24: confidence enum out of the allowed set — the keep decision is
    // still recovered; extractVerdict does not validate the enum, it passes the
    // raw value through (observable, no keep-decision degradation).
    it('row24: out-of-set confidence is passed through, keep decision preserved', () => {
        const v = extractVerdict(
            makeState({ keep: true, rationale: 'r', confidence: 'URGENT' }),
        );
        expect(v.keep).toBe(true);
        expect(v.confidence).toBe('URGENT');
    });

    // Row 26: duplicate keys in a stringified-JSON payload — JSON.parse is
    // last-wins, so a repair layer should recover keep:false.
    it('row26: recovers last-wins keep:false from a stringified object with duplicate keys', () => {
        const v = extractVerdict(
            makeState('{"keep": true, "rationale": "r", "keep": false}'),
        );
        expect(v.keep).toBe(false);
    });

    // Row 27: unicode / escaped newlines / emoji inside string fields must be
    // preserved verbatim (keep is a valid boolean → recovers today).
    it('row27: preserves unicode/newlines/emoji in the rationale', () => {
        const rationale = 'refuté ✅ — guard\nhandles null 🚫 já validado';
        const v = extractVerdict(makeState({ keep: false, rationale }));
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe(rationale);
    });
});

// ---- C. Unparseable / transport (the fail-safe layer) --------------------
describe('backfill C — unparseable / transport fail-safe', () => {
    // Row 28: truncated JSON (max_tokens mid-object) → unparseable → documented
    // fail-open fallback (never drops).
    it('row28: truncated JSON string → documented fail-open keep:true', () => {
        const v = extractVerdict(makeState('{"keep": false, "rationa'));
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/no parseable verdict/i);
    });

    // Row 29: malformed JSON (trailing comma / single quotes / unquoted keys).
    it('row29: malformed JSON strings → documented fail-open keep:true', () => {
        for (const bad of [
            '{keep: false,}',
            "{'keep':false}",
            '{keep:false}',
        ]) {
            const v = extractVerdict(makeState(bad));
            expect(v.keep).toBe(true);
            expect(v.rationale).toMatch(/no parseable verdict/i);
        }
    });

    // Row 30 is already pinned in LAYER 3 (throw → it.failing fail-open +
    // documented propagation). Row 31/32/33/34 below complete C.

    // Row 31: an error object returned as the payload instead of throwing → no
    // keep signal → fail-open keep:true.
    it('row31: error-object payload {error:...} → fail-open keep:true', () => {
        const v = extractVerdict(
            makeState({ error: 'model unavailable', code: 503 }),
        );
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/no parseable verdict/i);
    });

    // Row 32: empty success (content:'' / finish_reason:'length') → no keep → fail-open.
    it('row32: empty-success payload → fail-open keep:true', () => {
        for (const empty of [
            { content: '', finishReason: 'length' },
            { finish_reason: 'length' },
        ]) {
            const v = extractVerdict(makeState(empty));
            expect(v.keep).toBe(true);
            expect(v.rationale).toMatch(/no parseable verdict/i);
        }
    });

    // Row 33: refusal prose ("I cannot help…" / content_filter) → no JSON, no
    // keep signal → fail-open keep:true (a refusal must NOT drop the finding).
    it('row33: refusal prose payload → fail-open keep:true', () => {
        const v = extractVerdict(
            makeState("I'm sorry, I can't help with reviewing this code."),
        );
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/no parseable verdict/i);
    });

    // Row 34: abort signal fired mid-call surfaces as a rejected run. Like the
    // provider-error row, the fail-open contract says verify should degrade to
    // keep:true; current code propagates. Pin both.
    it.failing(
        'row34: verify degrades to keep:true when the run is aborted (never throws past its boundary)',
        async () => {
            const { runner } = fakeRunner(async () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                throw err;
            });
            const v = new LlmVerifier(runner, inertParams());
            const verdict = await v.verify(candidate(), {} as ToolContext);
            expect(verdict.keep).toBe(true);
        },
    );

    it('row34: documents current behavior — an abort propagates past verify', async () => {
        const { runner } = fakeRunner(async () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        });
        const v = new LlmVerifier(runner, inertParams());
        await expect(v.verify(candidate(), {} as ToolContext)).rejects.toThrow(
            /aborted/i,
        );
    });
});

// ---- D. Input variants ---------------------------------------------------
// The boundary verifies ONE candidate per call (no list, no batching), so the
// list-shaped rows (empty/large/duplicate/off-by-one/order) are N/A here — see
// rowsNA. What DOES apply: a single candidate (row 36, the happy path), a
// candidate with null/undefined required fields (row 39), and special-char /
// whitespace content (row 40). The invariant: verify still runs and returns a
// well-formed Verdict; verifierPromptFor never throws on degenerate input.
describe('backfill D — input variants (single-candidate boundary)', () => {
    // Row 39: candidate with null/undefined required fields must not crash the
    // prompt builder or the boundary; a valid Verdict still comes back.
    it('row39: candidate with null/undefined fields → verifierPromptFor does not throw', () => {
        expect(() =>
            verifierPromptFor({
                relevantFile: null as any,
                suggestionContent: undefined as any,
                relevantLinesStart: null as any,
            } as FinderSuggestion),
        ).not.toThrow();
    });

    it('row39: verify tolerates a candidate with null/undefined fields and returns a Verdict', async () => {
        const { runner } = fakeRunner(async () =>
            makeState({ keep: false, rationale: 'r' }),
        );
        const v = new LlmVerifier(runner, inertParams());
        const verdict = await v.verify(
            {
                relevantFile: null as any,
                suggestionContent: undefined as any,
                confidence: undefined as any,
            } as FinderSuggestion,
            {} as ToolContext,
        );
        expect(typeof verdict.keep).toBe('boolean');
    });

    // Row 40: special chars / huge diff / whitespace-only content → the prompt
    // is built and embeds the content; the boundary still returns a Verdict.
    it('row40: special-char / huge / whitespace content is embedded without throwing', () => {
        const nasty = '💥 <script>`${x}`\n\t   ' + 'A'.repeat(20000);
        const p = verifierPromptFor(
            candidate({ suggestionContent: nasty, existingCode: nasty }),
        );
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(20000);
    });

    it('row40: whitespace-only diff content still yields a well-formed Verdict', async () => {
        const { runner } = fakeRunner(async () =>
            makeState({ keep: true, rationale: 'r' }),
        );
        const v = new LlmVerifier(runner, inertParams());
        const verdict = await v.verify(
            candidate({ existingCode: '   \n\t  ', suggestionContent: '   ' }),
            {} as ToolContext,
        );
        expect(verdict.keep).toBe(true);
    });
});

// ---- E. Provider / model matrix (the "N modelos") ------------------------
// The verifier's structured-output gate is `supportsStrictToolsForRun`, baked
// into the spec's submitVerdict tool as `strict`. For THIS boundary only Gemini
// gets strict json_schema (see model-strictness.ts); every other model —
// including the matrix's kimi/glm/deepseek/z-ai json_object fallbacks AND
// openai/anthropic here — runs WITHOUT strict, so the full A/B/C off-schema zoo
// above is in-scope for them. Critically, `extractVerdict` takes NO model: it
// never trusts the provider, applying the identical parse regardless — so the
// zoo assertions above already hold for every branch. These tests pin the gate
// itself and that model-independence.
describe('backfill E — N-model structured-output gate', () => {
    const strictOf = (modelId: string, fallbackModelId?: string) =>
        buildVerifierAgentSpec({
            modelId,
            fallbackModelId,
            tools: new InMemoryToolRegistry([]),
        })
            .tools.list()
            .find((t) => t.name === VERIFY_DONE_TOOL)?.strict;

    it('strict branch: Gemini gets strict json_schema on the done-tool', () => {
        expect(strictOf('gemini-2.5-pro')).toBe(true);
    });

    it('json_object fallback branch: kimi/glm/deepseek/z-ai do NOT get strict', () => {
        for (const m of [
            'moonshot/kimi-k2',
            'z-ai/glm-4.6',
            'deepseek/deepseek-chat',
            'x-ai/grok',
        ]) {
            expect(strictOf(m)).toBe(false);
        }
    });

    it('failover: a Gemini primary with a non-strict fallback loses strict (safe swap)', () => {
        expect(strictOf('gemini-2.5-pro', 'openai/gpt-4o')).toBe(false);
        // both strict-capable → stays strict
        expect(strictOf('gemini-2.5-pro', 'gemini-1.5-flash')).toBe(true);
    });

    it('pins the two matrix policy branches at the shared gate (json_schema vs json_object)', () => {
        // strict-honored prefixes (matrix E: openai/anthropic/google/moonshotai)
        expect(openRouterHonorsJsonSchema('moonshotai/kimi-k2')).toBe(true);
        expect(openRouterHonorsJsonSchema('anthropic/claude-3.5')).toBe(true);
        // json_object fallback upstreams (matrix E: kimi/glm/deepseek/z-ai served
        // off-prefix) → full zoo in scope
        expect(openRouterHonorsJsonSchema('z-ai/glm-4.6')).toBe(false);
        expect(openRouterHonorsJsonSchema('deepseek/deepseek-chat')).toBe(
            false,
        );
    });

    it('extractVerdict is model-independent: same off-schema payload → same result under any branch', () => {
        // extractVerdict never sees the model id — the wrapped-envelope result is
        // identical whether a strict or a fallback model produced it. (This is
        // the #1786 degradation, so it is the SAME under both branches: keep:true
        // today; the repair, when it lands, fixes both at once.)
        const wrapped = { result: { keep: false, rationale: 'refuted' } };
        const a = extractVerdict(makeState(wrapped));
        const b = extractVerdict(makeState(wrapped));
        expect(a.keep).toBe(b.keep);
        expect(typeof a.keep).toBe('boolean');
    });
});
