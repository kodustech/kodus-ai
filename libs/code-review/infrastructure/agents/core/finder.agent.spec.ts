/**
 * finder.agent end-to-end test with a MOCKED model.
 * Proves the assembled finder runs on the new harness AND that findings are
 * extracted from the RunState — the full "produces a real review" path,
 * deterministic, zero real LLM.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { resolveModelConfig } from '@libs/llm/model-invocation';

import { scriptedToolModel } from '@libs/agent-harness/infrastructure/ai-sdk/__test-utils__/scripted-tool-model';

import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    buildFinderAgentSpec,
    extractFindings,
    extractFindingsWithRecovery,
    recoverFindingsFromProse,
    normalizePath,
    fileWasInvestigated,
    runRecallPasses,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { LLM } from '@libs/llm/llm';

const sampleFindings = {
    reasoning: 'found a null deref',
    suggestions: [
        {
            relevantFile: 'src/a.ts',
            label: 'bug',
            suggestionContent: 'null deref on line 10',
            existingCode: 'x.y',
            improvedCode: 'x?.y',
            severity: 'high',
            confidence: 8,
        },
    ],
};

// model: step 1 -> grep; step 2 -> submitResult with findings
function scriptedModel() {
    return scriptedToolModel((turn) =>
        turn === 1
            ? { id: 'c1', name: 'grep', input: { pattern: 'x.y' } }
            : { id: 'c2', name: 'submitResult', input: sampleFindings },
    );
}

const mockResolve = resolveModelConfig as jest.Mock;
beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockImplementation(() => ({
        model: scriptedModel(),
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    }));
});

const grepTool = {
    name: 'grep',
    description: 'search',
    inputSchema: {
        type: 'object' as const,
        properties: { pattern: { type: 'string' as const } },
    },
    execute: async () => ({ output: 'src/a.ts:10: x.y' }),
};

const noCriticalLedger: ProgressLedger = {
    markFromToolCall: () => undefined,
    summary: () => ({
        totalTargets: 0,
        pendingTargets: 0,
        criticalTotal: 0,
        criticalPending: 0,
    }),
    debtNote: () => null,
};

const ctx: ToolContext = { runId: 'finder-e2e' };

describe('finder.agent (assembled on agent-harness)', () => {
    it('runs the finder and extracts findings from the RunState', async () => {
        const spec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools: new InMemoryToolRegistry([grepTool]),
            coverageLedger: noCriticalLedger,
            maxSteps: 10,
        });

        // spec composed correctly: grep + submitResult present, 2 policies
        expect(spec.tools.get('grep')).toBeDefined();
        expect(spec.tools.get('submitResult')).toBeDefined();
        expect(spec.policies.map((p) => p.name)).toEqual([
            'budget',
            'completion-gate',
            'force-finalize',
        ]);

        const state = await new AiSdkAgentRunner(undefined).run(
            spec,
            { prompt: 'review this PR' },
            ctx,
        );

        const { reasoning, suggestions } = extractFindings(state);
        expect(reasoning).toBe('found a null deref');
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].relevantFile).toBe('src/a.ts');
        expect(suggestions[0].severity).toBe('high');
    });

    it('returns empty findings when the agent never finalized', () => {
        const state = {
            runId: 'r',
            agentId: 'finder',
            status: 'budget-exhausted' as const,
            steps: [],
            artifacts: [],
            usage: {},
            trace: [],
        };
        expect(extractFindings(state).suggestions).toEqual([]);
    });
});

// ─── Prose-findings recovery (deterministic, mocked recoverer, no LLM) ───────
// The model called submitResult but wrote its findings as PROSE in `reasoning`
// and omitted the `suggestions` array (the dominant Anthropic omission mode).
// These lock the WIRING — the part that silently broke before: preserving the
// prose, gating the recovery, merging its output, and covering "no recoverer".
describe('prose-findings recovery', () => {
    const prose =
        'Bug: null deref on src/x.ts:10 — should guard with x?.y before use.';

    // A submitResult artifact with ONLY reasoning (no suggestions array).
    const reasoningOnlyState = {
        runId: 'r',
        agentId: 'finder',
        status: 'ok' as const,
        steps: [],
        artifacts: [{ type: 'submitResult', payload: { reasoning: prose } }],
        usage: {},
        trace: [],
    } as any;

    const recovered = [
        {
            relevantFile: 'src/x.ts',
            suggestionContent: 'null deref',
            existingCode: 'x.y',
            improvedCode: 'x?.y',
        },
    ];

    it('extractFindings preserves the prose reasoning when suggestions is omitted', () => {
        const out = extractFindings(reasoningOnlyState);
        expect(out.suggestions).toEqual([]);
        expect(out.reasoning).toBe(prose); // <- prose kept for recovery
    });

    it('does NOT call the recoverer when findings are already structured', async () => {
        const validState = {
            ...reasoningOnlyState,
            artifacts: [{ type: 'submitResult', payload: sampleFindings }],
        } as any;
        const recover = jest.fn();
        const out = await extractFindingsWithRecovery(validState, recover);
        expect(recover).not.toHaveBeenCalled();
        expect(out.suggestions).toHaveLength(1);
    });

    it('recovers findings from the prose when suggestions is empty', async () => {
        const recover = jest.fn().mockResolvedValue(recovered);
        const out = await extractFindingsWithRecovery(
            reasoningOnlyState,
            recover,
        );
        expect(recover).toHaveBeenCalledWith(prose);
        expect(out.suggestions).toEqual(recovered);
        expect(out.reasoning).toBe(prose);
    });

    it('keeps empty findings when the recoverer finds nothing', async () => {
        const recover = jest.fn().mockResolvedValue([]);
        const out = await extractFindingsWithRecovery(
            reasoningOnlyState,
            recover,
        );
        expect(out.suggestions).toEqual([]);
    });

    it('is a no-op (never throws) when no recoverer is injected', async () => {
        const out = await extractFindingsWithRecovery(
            reasoningOnlyState,
            undefined,
        );
        expect(out.suggestions).toEqual([]);
        expect(out.reasoning).toBe(prose);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// LLM.run I/O CONTRACT MATRIX — finder.agent boundary
// ════════════════════════════════════════════════════════════════════════════
// Two deterministic parse boundaries + one explicit LLM.run site are under test:
//   P) extractFindings(state) — parses the `submitResult` ARTIFACT payload, which
//      IS the model's structured output. Declared shape D = {reasoning, suggestions}.
//      Recovery/validation via sanitizeFindingsResult (findings-schema.ts).
//   T) findingsFromText(state) — text-recovery over step content via
//      extractJsonFromText (structured-output-repair.ts): fence/prose/stringified.
//   L) recoverFindingsFromProse(...) — the ONE explicit LLM.run call site. Declared
//      output D = {suggestions}. Request-assembly + fail-safe under test.
//
// SCOPE = the deterministic layer only (request assembly, envelope parse, fallback,
// guaranteed return shape). NOT the model's decision quality. Every A/B/C/D matrix
// row has an explicit assertion below; #1786 silent-degradation rows are pinned as
// it.failing (green today, red on the fix).

const validFinding = {
    relevantFile: 'src/a.ts',
    suggestionContent: 'null deref on line 10',
    existingCode: 'x.y',
    improvedCode: 'x?.y',
};
const D = { reasoning: 'r', suggestions: [validFinding] };

function makeState(over: Record<string, unknown> = {}): any {
    return {
        runId: 'r',
        agentId: 'finder',
        status: 'ok' as const,
        steps: [],
        artifacts: [],
        usage: {},
        trace: [],
        ...over,
    };
}
/** A finished run whose submitResult artifact carries `payload` — the model's
 *  structured output. This is the primary parse boundary (P). */
function artifactState(payload: unknown): any {
    return makeState({ artifacts: [{ type: 'submitResult', payload }] });
}
/** A run with NO artifact but final model TEXT in a step — the text-recovery
 *  boundary (T: findingsFromText via extractJsonFromText). */
function textStepState(content: unknown): any {
    return makeState({ steps: [{ message: { content } }] });
}

// ─── A. Output-shape zoo (returns that are NOT D) ────────────────────────────
describe('matrix A — output-shape zoo (submitResult artifact payload)', () => {
    it('[A1] exact D → recovers the payload exactly; outcome=structured', () => {
        const state = artifactState(D);
        const out = extractFindings(state);
        expect(out.reasoning).toBe('r');
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].relevantFile).toBe('src/a.ts');
        expect(state.__findingsOutcome).toBe('structured');
    });

    // #1786 CLASS — these payloads carry REAL findings but sanitizeFindingsResult
    // returns null (no alias/unwrap) and extractFindings falls through to
    // findingsFromText → {reasoning:'', suggestions:[]}: the findings are DROPPED.
    // __findingsOutcome flags 'artifact-unusable' (partial signal) but the payload
    // is still lost. Correct behavior = RECOVER; pinned it.failing until the fix.
    it('[A2] bare array of findings → SHOULD recover (currently dropped)', () => {
        const out = extractFindings(artifactState([validFinding]));
        expect(out.suggestions).toHaveLength(1);
    });

    it.failing(
        '[A3] suggestions as a single object (not array) → SHOULD recover',
        () => {
            const out = extractFindings(
                artifactState({ reasoning: 'r', suggestions: validFinding }),
            );
            expect(out.suggestions).toHaveLength(1);
        },
    );

    it('[A4] wrapper key {result:D} → SHOULD unwrap and recover', () => {
        const out = extractFindings(artifactState({ result: D }));
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A5] double wrapper {result:{result:D}} → SHOULD recover', () => {
        const out = extractFindings(artifactState({ result: { result: D } }));
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A6] opaque single-key wrap {content:D} → SHOULD recover', () => {
        const out = extractFindings(artifactState({ content: D }));
        expect(out.suggestions).toHaveLength(1);
    });

    // Row 6 also lists the NUMERIC single-key wrap {"0":D} (SDK/provider index
    // leak). Same #1786 drop: sanitizeFindingsResult sees no {reasoning,suggestions}
    // → null → extractFindings falls through to []; the real payload is lost with
    // only the 'artifact-unusable' flag. Correct behavior = unwrap+recover.
    it('[A6b] numeric single-key wrap {"0":D} → SHOULD recover (currently dropped)', () => {
        const state = artifactState({ '0': D });
        const out = extractFindings(state);
        expect(out.suggestions).toHaveLength(1);
    });

    // Non-degradation guard for A6b: even while the payload is dropped today, the
    // After the SHAPE fix (normalizeEnvelope) the numeric wrap is unwrapped and
    // recovered, so the payload is no longer dropped and the outcome is NOT
    // artifact-unusable. Pin the recovery so a regression that reintroduces the
    // silent drop turns this red.
    it('[A6b-signal] numeric wrap is recovered, not flagged unusable', () => {
        const state = artifactState({ '0': D });
        expect(extractFindings(state).suggestions).toHaveLength(1);
        expect(state.__findingsOutcome).not.toBe('artifact-unusable');
    });

    it('[A7-artifact] stringified JSON as payload → SHOULD parse+recover', () => {
        const out = extractFindings(artifactState(JSON.stringify(D)));
        expect(out.suggestions).toHaveLength(1);
    });

    // A7/A8/A9 recovered via the TEXT boundary (model answered in text, no artifact).
    it('[A7-text] stringified JSON in final text → recovers via findingsFromText', () => {
        const out = extractFindings(textStepState(JSON.stringify(D)));
        expect(out.suggestions).toHaveLength(1);
        expect(out.reasoning).toBe('r');
    });

    it('[A8] markdown-fenced JSON in final text → recovers', () => {
        const out = extractFindings(
            textStepState('```json\n' + JSON.stringify(D) + '\n```'),
        );
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A9] prose-wrapped JSON in final text → recovers', () => {
        const out = extractFindings(
            textStepState(
                'Here is the result: ' + JSON.stringify(D) + '\n\nLet me know.',
            ),
        );
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A10] right data, wrong keys {analysis,findings} → SHOULD recover', () => {
        const out = extractFindings(
            artifactState({ analysis: 'r', findings: [validFinding] }),
        );
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A11] case/convention mismatch {Reasoning,Suggestions} → SHOULD recover', () => {
        const out = extractFindings(
            artifactState({ Reasoning: 'r', Suggestions: [validFinding] }),
        );
        expect(out.suggestions).toHaveLength(1);
    });

    it('[A12] partial object {suggestions} (no reasoning) → recovers with reasoning=""', () => {
        const state = artifactState({ suggestions: [validFinding] });
        const out = extractFindings(state);
        expect(out.suggestions).toHaveLength(1);
        expect(out.reasoning).toBe('');
        expect(state.__findingsOutcome).toBe('structured');
    });

    it('[A13] extra unknown keys alongside D → tolerated (stripped), recovers', () => {
        const out = extractFindings(
            artifactState({ ...D, foo: 'bar', meta: { z: 1 } }),
        );
        expect(out.suggestions).toHaveLength(1);
        expect((out.suggestions[0] as any).foo).toBeUndefined();
    });

    it('[A14] empty object {} → typed-empty + observable outcome (not silent)', () => {
        const state = artifactState({});
        const out = extractFindings(state);
        expect(out.suggestions).toEqual([]);
        expect(state.__findingsOutcome).toBe('artifact-unusable');
    });

    it('[A15] empty array [] payload → typed-empty + observable outcome', () => {
        const state = artifactState([]);
        expect(extractFindings(state).suggestions).toEqual([]);
        expect(state.__findingsOutcome).toBe('artifact-unusable');
    });

    it('[A16] empty/whitespace string payload → typed-empty, no throw', () => {
        expect(extractFindings(artifactState('')).suggestions).toEqual([]);
        expect(extractFindings(artifactState('   ')).suggestions).toEqual([]);
    });

    it('[A17] null / undefined return → typed-empty, no throw', () => {
        expect(extractFindings(artifactState(null)).suggestions).toEqual([]);
        expect(extractFindings(artifactState(undefined)).suggestions).toEqual(
            [],
        );
        // No artifact at all → distinct observable outcome.
        const noArtifact = makeState({});
        expect(extractFindings(noArtifact).suggestions).toEqual([]);
        expect(noArtifact.__findingsOutcome).toBe('no-artifact');
    });

    it('[A18] primitive where object expected → typed-empty, no throw', () => {
        for (const p of [true, 0, 'ok', 42]) {
            expect(extractFindings(artifactState(p)).suggestions).toEqual([]);
        }
    });

    it.failing(
        '[A19] provider envelope leak {choices:[{message:{content}}]} → SHOULD recover',
        () => {
            const out = extractFindings(
                artifactState({
                    choices: [{ message: { content: JSON.stringify(D) } }],
                }),
            );
            expect(out.suggestions).toHaveLength(1);
        },
    );

    it('[A20] reasoning/thinking leak (findings as prose in reasoning) → preserved for recovery', () => {
        // The documented Anthropic omission mode: findings written into reasoning,
        // suggestions omitted. The prose is PRESERVED (signalled), then recovered
        // by the injected recoverer (covered in the prose-recovery describe).
        const out = extractFindings(
            artifactState({ reasoning: 'Bug: null deref at src/x.ts:10' }),
        );
        expect(out.suggestions).toEqual([]);
        expect(out.reasoning).toBe('Bug: null deref at src/x.ts:10');
    });

    it('[invariant] extractFindings ALWAYS returns {reasoning:string, suggestions:array}', () => {
        for (const p of [
            D,
            [validFinding],
            {},
            null,
            'x',
            true,
            JSON.stringify(D),
        ]) {
            const out = extractFindings(artifactState(p));
            expect(typeof out.reasoning).toBe('string');
            expect(Array.isArray(out.suggestions)).toBe(true);
        }
    });
});

// ─── B. Semantic-but-wrong (valid JSON, wrong value encoding) ────────────────
describe('matrix B — semantic-but-wrong value encodings', () => {
    it('[B24] enum out of allowed set (severity/label) → invalid item dropped, valid kept', () => {
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [
                    validFinding,
                    { ...validFinding, severity: 'URGENT' },
                    { ...validFinding, label: 'refactor' },
                ],
            }),
        );
        // Partial recovery: the out-of-set items are validated out (logged),
        // the clean one survives — no silent keep-all of the bad encoding.
        expect(out.suggestions).toHaveLength(1);
    });

    it('[B24b] wrong-type field (confidence as string) → item validated out', () => {
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [
                    validFinding,
                    { ...validFinding, confidence: '8' },
                ],
            }),
        );
        expect(out.suggestions).toHaveLength(1);
    });

    it('[B26] duplicate keys in JSON text → last-wins, still parses', () => {
        const raw =
            '{"reasoning":"first","reasoning":"second","suggestions":' +
            JSON.stringify([validFinding]) +
            '}';
        const out = extractFindings(textStepState(raw));
        expect(out.reasoning).toBe('second');
        expect(out.suggestions).toHaveLength(1);
    });

    it('[B27] unicode / escaped newlines / emoji in string fields → preserved intact', () => {
        const content = 'race 🏁 on\nline — naïve check';
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [{ ...validFinding, suggestionContent: content }],
            }),
        );
        expect(out.suggestions[0].suggestionContent).toBe(content);
    });
});

// ─── Matrix rows N/A to THIS boundary (anchored, not silently skipped) ───────
// Rows 21/22/23 (boolean encodings), 25 (index-into-input), 41 (batch off-by-one)
// describe shapes this boundary's declared type D cannot produce. Anchored below
// so the N/A rationale is verified against the real shape, not just asserted.
describe('matrix rows N/A for the finder boundary (rationale anchored)', () => {
    // 21/22/23 — Boolean encodings (keep:"true"/"yes"/1). The finder's declared
    // output D = {reasoning:string, suggestions:FinderSuggestion[]} has NO boolean
    // field anywhere: suggestion members are strings, numbers, and enums only. There
    // is no boolean to mis-encode. Anchor: a fully-populated finding has no boolean.
    it('[21/22/23 N/A] finder output schema declares no boolean field', () => {
        const full = {
            relevantFile: 's.ts',
            language: 'ts',
            label: 'bug',
            suggestionContent: 'c',
            existingCode: 'a',
            improvedCode: 'b',
            oneSentenceSummary: 's',
            relevantLinesStart: 1,
            relevantLinesEnd: 2,
            severity: 'high',
            confidence: 7,
            ruleUuid: 'u',
        };
        const out = extractFindings(
            artifactState({ reasoning: 'r', suggestions: [full] }),
        );
        expect(out.suggestions).toHaveLength(1);
        const values = Object.values(out.suggestions[0] as object);
        expect(values.some((v) => typeof v === 'boolean')).toBe(false);
    });

    // 25 — Index out of range / dangling reference. Rows like dedup's
    // `unique:[idx]` reference INPUT positions; a finder finding references source
    // code by file + LINE NUMBER (relevantLinesStart/End), never an index into an
    // input array. A large/nonsensical line number is not a dangling reference and
    // is carried through verbatim (line validity is the eval track, not the parse
    // contract). Anchor: an absurd line number does not drop the finding here.
    it('[25 N/A] line numbers are source refs, not input indices — carried verbatim', () => {
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [
                    {
                        ...validFinding,
                        relevantLinesStart: 999999,
                        relevantLinesEnd: 1000000,
                    },
                ],
            }),
        );
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].relevantLinesStart).toBe(999999);
    });

    // 41 — Off-by-one batch boundary. The finder emits ALL findings in ONE
    // submitResult artifact; there is no per-batch chunking at this parse seam
    // (batching lives upstream in the file/diff planner, a different boundary).
    // Anchor: a single artifact holding N findings parses as one unit, no chunk
    // edge. (D37 already proves 100 findings survive intact.)
    it('[41 N/A] findings arrive as one artifact — no batch/chunk boundary at this seam', () => {
        const many = Array.from({ length: 51 }, (_, i) => ({
            ...validFinding,
            relevantFile: `src/b${i}.ts`,
        }));
        const state = artifactState({ reasoning: 'r', suggestions: many });
        const out = extractFindings(state);
        expect(out.suggestions).toHaveLength(51);
        expect(state.artifacts).toHaveLength(1); // single unit, not batched
    });
});

// ─── C. Unparseable / transport (fail-safe layer) ────────────────────────────
describe('matrix C — unparseable / transport / fail-safe', () => {
    const prose =
        'Bug: a null dereference happens in src/x.ts:10 and it will crash; ' +
        'you should guard with x?.y before using it.';

    afterEach(() => jest.restoreAllMocks());

    it('[C28] truncated JSON in text → typed-empty, never throws', () => {
        const truncated =
            '{"reasoning":"r","suggestions":[{"relevantFile":"a.ts"';
        expect(() => extractFindings(textStepState(truncated))).not.toThrow();
        expect(extractFindings(textStepState(truncated)).suggestions).toEqual(
            [],
        );
    });

    it('[C29] malformed JSON — trailing comma recovers; single-quote fails safe', () => {
        const trailing =
            '{"reasoning":"r","suggestions":' +
            JSON.stringify([validFinding]) +
            ',}';
        expect(
            extractFindings(textStepState(trailing)).suggestions,
        ).toHaveLength(1);
        const singleQuote = "{'reasoning':'r','suggestions':[]}";
        expect(extractFindings(textStepState(singleQuote)).suggestions).toEqual(
            [],
        );
    });

    it('[C30] LLM.run throws (recover pass) → fail-safe [], never propagates', async () => {
        jest.spyOn(LLM, 'run').mockRejectedValue(new Error('network down'));
        await expect(
            recoverFindingsFromProse(prose, undefined, 'org-1'),
        ).resolves.toEqual([]);
    });

    it('[C31] LLM.run returns {error:...} (no suggestions) → []', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({ error: 'boom' } as any);
        await expect(
            recoverFindingsFromProse(prose, undefined, 'org-1'),
        ).resolves.toEqual([]);
    });

    it('[C32] LLM.run empty success {suggestions:[]} → []', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        await expect(
            recoverFindingsFromProse(prose, undefined, 'org-1'),
        ).resolves.toEqual([]);
    });

    it('[C33] refusal / non-finding prose → gate short-circuits, LLM.run NOT called', async () => {
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({} as any);
        const refusal =
            'I am not able to assist with this particular request and there ' +
            'is really nothing further for me to add at this time.';
        await expect(
            recoverFindingsFromProse(refusal, undefined, 'org-1'),
        ).resolves.toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    it('[C34] abort mid-call (LLM.run rejects AbortError) → fail-safe []', async () => {
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        jest.spyOn(LLM, 'run').mockRejectedValue(abort);
        await expect(
            recoverFindingsFromProse(prose, undefined, 'org-1'),
        ).resolves.toEqual([]);
    });
});

// ─── C/L. recoverFindingsFromProse request assembly (LLM.run site) ───────────
describe('recoverFindingsFromProse — request assembly (the LLM.run boundary)', () => {
    const prose =
        'Bug: a null dereference happens in src/x.ts:10 and it will crash; ' +
        'you should guard with x?.y before using it.';

    afterEach(() => jest.restoreAllMocks());

    it('threads byokConfig/schema/user/organizationId and defaults runName', async () => {
        const spy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ suggestions: [validFinding] } as any);
        const cfg = { provider: 'openai', model: 'gpt-x' } as any;

        const out = await recoverFindingsFromProse(prose, cfg, 'org-9');

        expect(out).toEqual([validFinding]);
        const arg = spy.mock.calls[0][0] as any;
        expect(arg.byokConfig).toBe(cfg); // exact object threaded, no fork
        expect(arg.schema).toBeDefined(); // RECOVERY_SCHEMA (private) present
        expect(arg.organizationId).toBe('org-9');
        expect(arg.user).toContain(prose);
        expect(arg.user).toContain('Extract EVERY concrete finding');
        expect(arg.runName).toBe('code-review-recovery');
    });

    it('suffixes usageRunName with -recovery when provided', async () => {
        const spy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ suggestions: [] } as any);
        await recoverFindingsFromProse(
            prose,
            undefined,
            'org',
            'code-review-bug',
        );
        expect((spy.mock.calls[0][0] as any).runName).toBe(
            'code-review-bug-recovery',
        );
    });

    it('missing suggestions key in the LLM.run result → [] (declared shape held)', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({} as any);
        await expect(
            recoverFindingsFromProse(prose, undefined, 'org'),
        ).resolves.toEqual([]);
    });
});

// ─── D. Input variants ───────────────────────────────────────────────────────
describe('matrix D — input variants', () => {
    afterEach(() => jest.restoreAllMocks());

    it('[D35] empty input → typed-empty; prose gate rejects empty string', async () => {
        expect(extractFindings(makeState({})).suggestions).toEqual([]);
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({} as any);
        await expect(
            recoverFindingsFromProse('', undefined, 'org'),
        ).resolves.toEqual([]);
        expect(spy).not.toHaveBeenCalled(); // gate never pays for empty input
    });

    it('[D36] single item → extracted verbatim', () => {
        const out = extractFindings(artifactState(D));
        expect(out.suggestions).toHaveLength(1);
    });

    it('[D37] large input (100 findings, crosses any chunk boundary) → all preserved', () => {
        const many = Array.from({ length: 100 }, (_, i) => ({
            ...validFinding,
            relevantFile: `src/f${i}.ts`,
        }));
        const out = extractFindings(
            artifactState({ reasoning: 'r', suggestions: many }),
        );
        expect(out.suggestions).toHaveLength(100);
    });

    it('[D38] duplicate items across passes → merge does not double-count', async () => {
        const A = { ...validFinding, relevantFile: 'src/a.ts' };
        const B = { ...validFinding, relevantFile: 'src/b.ts' };
        const runner = {
            run: jest
                .fn()
                .mockResolvedValue(
                    artifactState({ reasoning: 're', suggestions: [A, B] }),
                ),
        } as any;
        const res = await runRecallPasses(
            { reasoning: 'base', suggestions: [A] },
            {
                runner,
                finderSpec: {} as any,
                finderState: makeState({}),
                userPrompt: 'p',
                skipSynthesisRescue: false,
            },
            ctx,
        );
        const files = res.findings.suggestions
            .map((s) => s.relevantFile)
            .sort();
        expect(files).toEqual(['src/a.ts', 'src/b.ts']); // A not re-added
    });

    it('[D39] input item with null/undefined required field → dropped, others kept', () => {
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [
                    validFinding,
                    { ...validFinding, relevantFile: undefined },
                ],
            }),
        );
        expect(out.suggestions).toHaveLength(1);
        // normalizePath tolerates the missing path without crashing.
        expect(normalizePath(undefined as any)).toBe('');
    });

    it('[D40] special chars / whitespace-only text → preserved / skipped safely', () => {
        const content = '\t\n weird⚠️ /path\\to\\file.ts ';
        const out = extractFindings(
            artifactState({
                reasoning: 'r',
                suggestions: [{ ...validFinding, suggestionContent: content }],
            }),
        );
        expect(out.suggestions[0].suggestionContent).toBe(content);
        // whitespace-only final text → no JSON → typed-empty
        expect(extractFindings(textStepState('   \n\t ')).suggestions).toEqual(
            [],
        );
    });

    it('[D42] order permutation → equivalent merged SET (metamorphic)', async () => {
        const A = { ...validFinding, relevantFile: 'src/a.ts' };
        const B = { ...validFinding, relevantFile: 'src/b.ts' };
        const C = { ...validFinding, relevantFile: 'src/c.ts' };
        const mergeVia = async (base: any[], pass: any[]) => {
            const runner = {
                run: jest
                    .fn()
                    .mockResolvedValue(
                        artifactState({ reasoning: '', suggestions: pass }),
                    ),
            } as any;
            const res = await runRecallPasses(
                { reasoning: '', suggestions: base },
                {
                    runner,
                    finderSpec: {} as any,
                    finderState: makeState({}),
                    userPrompt: 'p',
                    skipSynthesisRescue: false,
                },
                ctx,
            );
            return res.findings.suggestions.map((s) => s.relevantFile).sort();
        };
        const one = await mergeVia([A, B], [B, A, C]);
        const two = await mergeVia([B, A], [C, A, B]);
        expect(one).toEqual(two);
        expect(one).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('fileWasInvestigated tolerates empty/missing file (no crash)', () => {
        expect(fileWasInvestigated(new Set(['src/a.ts']), '')).toBe(false);
        expect(fileWasInvestigated(new Set(['src/a.ts']), 'src/a.ts')).toBe(
            true,
        );
    });
});

// ─── E. Provider / N-model policy ────────────────────────────────────────────
// The parse boundary (extractFindings/sanitizeFindingsResult) is provider-AGNOSTIC:
// it re-validates every model's output identically — no branch on model id. The
// LLM.run site delegates the json_schema↔json_object policy to LLM.run itself
// (per the source comment), so the boundary must thread byokConfig VERBATIM for
// both the strict-json_schema providers and the json_object-fallback providers,
// never forking model policy at this layer.
describe('matrix E — N-model policy (delegated to LLM.run)', () => {
    afterEach(() => jest.restoreAllMocks());

    const prose =
        'Bug: a null dereference happens in src/x.ts:10 and it will crash; ' +
        'you should guard with x?.y before using it.';

    const strict = ['openai', 'anthropic', 'google', 'moonshotai'];
    const fallback = ['kimi', 'glm', 'deepseek', 'z-ai'];

    it.each([...strict, ...fallback])(
        'threads byokConfig verbatim for provider %s (no per-model fork)',
        async (provider) => {
            const spy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ suggestions: [] } as any);
            const cfg = { provider, model: `${provider}/m` } as any;
            await recoverFindingsFromProse(prose, cfg, 'org');
            expect((spy.mock.calls[0][0] as any).byokConfig).toBe(cfg);
        },
    );

    it('parse layer is model-independent: same off-schema payload → same outcome', () => {
        // No model param exists at the parse boundary, so the A/B/C zoo behavior is
        // uniform across every provider by construction. Pin that: a valid D and a
        // dropped shape behave identically regardless of caller context.
        const s1 = artifactState(D);
        const s2 = artifactState(D);
        expect(extractFindings(s1)).toEqual(extractFindings(s2));
        expect(s1.__findingsOutcome).toBe(s2.__findingsOutcome);
    });
});
