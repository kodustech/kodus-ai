/**
 * runAgentLoopViaCore e2e — the harness+agent integration boundary, mocked model,
 * zero real LLM. Drives the FULL path the review pipeline uses:
 *   wrapByokModel -> AiSdkAgentRunner -> finder -> recall passes -> verify (HV2)
 *   -> map RunState -> AgentLoopOutput.
 *
 * Validates what only the adapter does (the wiring + the output mapping) and that
 * the recall passes actually fire through it (skipped in fast mode).
 */
// core-agent-loop now passes the SLOT to the runner; LLM.run resolves the model
// via resolveModelConfig — mock it to inject the scripted MockLanguageModelV3.
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV3 } from 'ai/test';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
// The DETERMINISTIC parse layer the adapter's LLM.run boundary delegates to:
// the finder done-tool payload (D = {reasoning, suggestions}) and the verifier
// done-tool payload (D = {keep, rationale}). These are where off-schema model
// output is recovered, degraded, or signalled — so the I/O contract matrix
// (A output-shape zoo / B semantic-but-wrong / C fail-safe) is asserted here,
// at the exact layer the boundary uses, alongside the end-to-end wiring tests.
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import {
    extractFindings,
    extractFindingsWithRecovery,
    recoverFindingsFromProse,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { extractVerdict } from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { supportsStrictToolsForRun } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import { LLM } from '@libs/llm/llm';

const mockResolve = resolveModelConfig as jest.Mock;

const findings = {
    reasoning: 'two candidates',
    suggestions: [
        {
            relevantFile: 'a.ts',
            suggestionContent: 'real bug',
            existingCode: 'x',
            improvedCode: 'y',
            severity: 'high',
        },
        {
            relevantFile: 'b.ts',
            suggestionContent: 'false positive',
            existingCode: 'p',
            improvedCode: 'q',
            severity: 'low',
        },
    ],
};

/** One mock model drives every model call (finder, recall passes, verifier).
 *  Returns a shared call counter so a test can prove recall passes ran. */
function makeModel() {
    const calls = { count: 0 };
    const doGenerate = (async (opts: any) => {
        calls.count++;
        const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
        const isVerifier =
            sys.includes('REFUTE') ||
            sys.includes('verdict') ||
            sys.includes('verify');
        let tc: any;
        if (isVerifier) {
            const refute = sys.includes('false positive');
            tc = {
                id: 'v',
                name: 'submitVerdict',
                input: { keep: !refute, rationale: refute ? 'refuted' : 'ok' },
            };
        } else {
            tc = { id: 'f', name: 'submitResult', input: findings };
        }
        return {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: tc.id,
                    toolName: tc.name,
                    input: JSON.stringify(tc.input),
                },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 5, outputTokens: 5 },
            warnings: [],
        };
    }) as any;
    return { model: new MockLanguageModelV3({ doGenerate }), calls };
}

const fakeRemoteCommands = {
    grep: jest.fn(async () => ''),
    read: jest.fn(async () => ''),
    listDir: jest.fn(async () => ''),
    exec: jest.fn(async () => ({ stdout: '', exitCode: 0 })),
};

function makeInput(model: any, over: Record<string, unknown> = {}): any {
    // The adapter no longer builds from input.model — LLM.run resolves via
    // resolveModelConfig, so point the mock at this test's scripted model.
    mockResolve.mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    return {
        model,
        systemPrompt: 'find bugs',
        userPrompt: 'review this PR',
        agentName: 'finder',
        telemetryMetadata: {
            organizationId: 'org',
            teamId: 'team',
            pullRequestId: 1,
            repositoryId: 'repo',
            provider: 'mock',
        },
        changedFiles: [
            { filename: 'a.ts', patch: '@@ -1,1 +1,2 @@\n+const x=1;' },
            { filename: 'b.ts', patch: '@@ -1,1 +1,2 @@\n+const y=2;' },
        ],
        prNumber: 1,
        repositoryFullName: 'org/repo',
        reviewMode: 'fast',
        maxSteps: 3,
        contextWindowTokens: 200_000,
        ...over,
    };
}

const secrets: any = {
    remoteCommands: fakeRemoteCommands,
    byokConfig: undefined,
    byokQueueTimeoutMs: undefined,
};

describe('runAgentLoopViaCore (harness + agent integration)', () => {
    it('runs finder + verify end-to-end and maps RunState -> AgentLoopOutput', async () => {
        const { model } = makeModel();
        const out = await runAgentLoopViaCore(makeInput(model), secrets);

        // verify funnel: 2 found, FP refuted -> 1 kept, 1 dropped
        expect(out.findings.suggestions.map((s: any) => s.relevantFile)).toEqual(
            ['a.ts'],
        );
        expect(
            out.droppedByVerify.map((s: any) => s.relevantFile),
        ).toEqual(['b.ts']);
        expect(out.verification?.beforeCount).toBe(2);
        expect(out.verification?.afterCount).toBe(1);
        expect(out.verification?.droppedByVerifier).toBe(1);

        // mapping basics (usage is summed fu+vu+ru; exact token counts depend on
        // real model usage — the mock doesn't propagate it, so assert the shape)
        expect(out.source).toBe('json-parse');
        expect(typeof out.usage.totalTokens).toBe('number');
        expect(out.usage).toMatchObject({
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
            cacheReadTokens: expect.any(Number),
        });
        expect(Array.isArray(out.toolCalls)).toBe(true);
        expect(out.coverage).toBeDefined();
        expect(out.anomalies).toBeDefined();
        expect(out.verificationUsage).toBeDefined();
    });

    it('skips recall passes in fast mode but runs them otherwise (more model calls)', async () => {
        const fast = makeModel();
        await runAgentLoopViaCore(
            makeInput(fast.model, { reviewMode: 'fast' }),
            secrets,
        );

        const normal = makeModel();
        await runAgentLoopViaCore(
            makeInput(normal.model, { reviewMode: 'normal' }),
            secrets,
        );

        // normal mode adds at least the synthesis-rescue pass -> more calls.
        expect(normal.calls.count).toBeGreaterThan(fast.calls.count);
    });

    it('self-contained (no remoteCommands) still produces output', async () => {
        const { model } = makeModel();
        const out = await runAgentLoopViaCore(makeInput(model), {
            ...secrets,
            remoteCommands: undefined,
        });
        expect(out.findings).toBeDefined();
        expect(out.usage).toBeDefined();
    });

    it('reports coverage from the ledger mutated during the run', async () => {
        const calls = { count: 0 };
        const doGenerate = (async (opts: any) => {
            calls.count++;
            const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
            const isVerifier =
                sys.includes('REFUTE') ||
                sys.includes('verdict') ||
                sys.includes('verify');

            if (isVerifier) {
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'v',
                            toolName: 'submitVerdict',
                            input: JSON.stringify({
                                keep: true,
                                rationale: 'ok',
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }

            if (calls.count === 1) {
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'r',
                            toolName: 'readFile',
                            input: JSON.stringify({
                                path: 'a.ts',
                                startLine: 1,
                                endLine: 2,
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }

            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'f',
                        toolName: 'submitResult',
                        input: JSON.stringify({
                            reasoning: 'done',
                            suggestions: [],
                        }),
                    },
                ],
                finishReason: 'tool-calls',
                usage: { inputTokens: 5, outputTokens: 5 },
                warnings: [],
            };
        }) as any;

        const out = await runAgentLoopViaCore(
            makeInput(new MockLanguageModelV3({ doGenerate }), {
                reviewMode: 'fast',
                maxSteps: 4,
            }),
            secrets,
        );

        expect(out.coverage.totalTargets).toBe(2);
        expect(out.coverage.touchedTargets).toBe(1);
        expect(out.coverage.pendingTargets).toBe(1);
        expect(out.coverage.touchedFiles).toEqual(['a.ts']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
//  LLM.run I/O CONTRACT MATRIX — the deterministic parse + fail-safe + return-
//  shape layers the adapter boundary depends on. See llm-io-contract-matrix.md.
//
//  The adapter delegates the model call to the harness runner; the payload it
//  gets back is the done-tool argument object, parsed at TWO seams:
//    - finder findings  D = {reasoning, suggestions}  via sanitizeFindingsResult
//      / extractFindings (+ prose-recovery fallback)
//    - verifier verdict D = {keep, rationale}          via extractVerdict
//  Every applicable matrix row is asserted against those seams (and the
//  end-to-end adapter path where the wiring/fail-safe matters). Rows that
//  silently degrade in production today (the #1786 class) are pinned as
//  it.failing on the CORRECT behavior — green now, red when the seam is fixed.
// ════════════════════════════════════════════════════════════════════════════

/** A schema-valid finder suggestion item. */
const validItem = (over: Record<string, unknown> = {}) => ({
    relevantFile: 'a.ts',
    suggestionContent: 'null deref on the returned value',
    existingCode: 'const v = get();',
    improvedCode: 'const v = get(); if (!v) return;',
    ...over,
});

/** Build a minimal RunState fixture. */
function mkState(over: Partial<Record<string, unknown>> = {}): any {
    return {
        runId: 'r',
        agentId: 'finder',
        status: 'completed',
        steps: [],
        artifacts: [],
        usage: {},
        trace: [],
        ...over,
    };
}
const stepText = (content: string) => ({
    index: 0,
    message: { role: 'assistant', content },
});
const finderArtifact = (payload: unknown) => ({
    type: 'submitResult',
    payload,
});
const verdictArtifact = (payload: unknown) => ({
    type: 'submitVerdict',
    payload,
});

/** A model that finalizes with EXACTLY the given submitResult payload object
 *  (drives the off-schema shape through the real harness end-to-end). */
function modelReturningFindings(payload: unknown) {
    return new MockLanguageModelV3({
        doGenerate: (async () => ({
            content: [
                {
                    type: 'tool-call',
                    toolCallId: 'f',
                    toolName: 'submitResult',
                    input: JSON.stringify(payload),
                },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
        })) as any,
    });
}

/** A model that finalizes with an EMPTY, clean findings set (fast, no verify).
 *  Used for the input-variant (D) invariant tests. */
function happyEmptyModel() {
    return modelReturningFindings({
        reasoning: 'reviewed, nothing found',
        suggestions: [],
    });
}

/** The declared AgentLoopOutput shape must ALWAYS be returned, every row. */
function assertAgentLoopOutputShape(out: any) {
    expect(out).toBeDefined();
    expect(out.findings).toBeDefined();
    expect(Array.isArray(out.findings.suggestions)).toBe(true);
    expect(typeof out.findings.reasoning).toBe('string');
    expect(typeof out.text).toBe('string');
    expect(typeof out.steps).toBe('number');
    expect(Array.isArray(out.toolCalls)).toBe(true);
    expect(typeof out.finishReason).toBe('string');
    expect(['json-parse', 'generate-object', 'empty']).toContain(out.source);
    expect(out.usage).toEqual(
        expect.objectContaining({
            inputTokens: expect.any(Number),
            cacheReadTokens: expect.any(Number),
            cacheWriteTokens: expect.any(Number),
            outputTokens: expect.any(Number),
            reasoningTokens: expect.any(Number),
            totalTokens: expect.any(Number),
        }),
    );
    expect(out.usage.cacheWriteTokens).toBe(0); // implicit-cache invariant
    expect(Array.isArray(out.discardedBySeverity)).toBe(true);
    expect(out.discardedBySeverity).toEqual([]); // no severity pre-filter, by design
    expect(Array.isArray(out.droppedByVerify)).toBe(true);
    expect(out.coverage).toBeDefined();
    expect(out.anomalies).toBeDefined();
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.verification === null || typeof out.verification === 'object').toBe(
        true,
    );
    expect(out.verificationUsage).toBeDefined();
}

describe('contract matrix — A. output-shape zoo (finder findings seam)', () => {
    // Row 1 — Exact D: happy path recovers the payload untouched.
    it('row 1 — exact D returns the payload', () => {
        const r = sanitizeFindingsResult({
            reasoning: 'two candidates',
            suggestions: [validItem()],
        } as any);
        expect(r).not.toBeNull();
        expect(r!.reasoning).toBe('two candidates');
        expect(r!.suggestions).toHaveLength(1);
        expect(r!.suggestions[0].relevantFile).toBe('a.ts');
    });

    // Row 2 — Bare array of inner items where D is an object.
    // PROD: sanitizeFindingsResult only checks `raw.suggestions` (undefined on an
    // array) → returns null → findings SILENTLY DROPPED (findings-schema.ts:63).
    it.failing(
        'row 2 — bare array of findings must be recovered, not silently dropped',
        () => {
            const r = sanitizeFindingsResult([validItem()] as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 3 — Single object where D expects an array (suggestions as one object).
    // PROD: Array.isArray(raw.suggestions) === false → null → silent drop.
    it.failing(
        'row 3 — single suggestion object must be wrapped, not silently dropped',
        () => {
            const r = sanitizeFindingsResult({
                reasoning: 'r',
                suggestions: validItem(),
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 4 — Wrapper key {result: D} / {data: D} / {output: D} / {json: D}.
    // PROD: top-level lacks reasoning+suggestions → null → silent drop.
    it.failing(
        'row 4 — a {result:D} wrapper must be unwrapped, not silently dropped',
        () => {
            const r = sanitizeFindingsResult({
                result: { reasoning: 'r', suggestions: [validItem()] },
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 5 — Double wrapper {result:{result:D}}.
    it.failing(
        'row 5 — a double {result:{result:D}} wrapper must be unwrapped',
        () => {
            const r = sanitizeFindingsResult({
                result: { result: { reasoning: 'r', suggestions: [validItem()] } },
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 6 — Numeric/opaque single-key wrap {"0":D} / {content:D}.
    it.failing(
        'row 6 — an opaque single-key wrap ({content:D}) must be unwrapped',
        () => {
            const r = sanitizeFindingsResult({
                content: { reasoning: 'r', suggestions: [validItem()] },
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 7 — Stringified JSON: the whole D as a JSON string.
    // PROD: sanitize sees a string, safeParse fails → null → silent drop.
    it.failing(
        'row 7 — stringified-JSON findings must be parsed, not silently dropped',
        () => {
            const r = sanitizeFindingsResult(
                JSON.stringify({
                    reasoning: 'r',
                    suggestions: [validItem()],
                }) as any,
            );
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 8 — Markdown-fenced: RECOVERED at the text seam (extractFindings /
    // extractJsonFromText strips the ```json fence).
    it('row 8 — markdown-fenced JSON is recovered from the final text', () => {
        const state = mkState({
            steps: [
                stepText(
                    '```json\n{"reasoning":"r","suggestions":[' +
                        JSON.stringify(validItem()) +
                        ']}\n```',
                ),
            ],
        });
        const out = extractFindings(state);
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].relevantFile).toBe('a.ts');
    });

    // Row 9 — Prose-wrapped JSON: RECOVERED (prose before/after is dropped).
    it('row 9 — prose-wrapped JSON is recovered from the final text', () => {
        const state = mkState({
            steps: [
                stepText(
                    'Here is the result: {"reasoning":"r","suggestions":[' +
                        JSON.stringify(validItem()) +
                        ']}\n\nLet me know if you need more.',
                ),
            ],
        });
        const out = extractFindings(state);
        expect(out.suggestions).toHaveLength(1);
    });

    // Row 10 — Right data, wrong keys.
    // (a) item-level rename (relevantFile → file): the DOCUMENTED partial-recovery
    //     contract drops the invalid item (logged) and keeps the valid ones.
    it('row 10a — a renamed-key item is dropped by partial recovery, valid kept', () => {
        const r = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                validItem(), // valid → kept
                { file: 'b.ts', suggestionContent: 'x' }, // renamed keys → dropped
            ],
        } as any);
        expect(r).not.toBeNull();
        expect(r!.suggestions).toHaveLength(1);
        expect(r!.suggestions[0].relevantFile).toBe('a.ts');
    });
    // (b) top-level rename (suggestions → findings): the whole payload is lost.
    it.failing(
        'row 10b — a top-level renamed key (findings→suggestions) must be aliased',
        () => {
            const r = sanitizeFindingsResult({
                reasoning: 'r',
                findings: [validItem()],
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 11 — Case/convention mismatch on the top-level keys ({Reasoning,
    // Suggestions}). PROD: schema fails, suggestions missing → null → silent drop.
    it.failing(
        'row 11 — case-mismatched top-level keys must be normalized, not dropped',
        () => {
            const r = sanitizeFindingsResult({
                Reasoning: 'r',
                Suggestions: [validItem()],
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (null)
        },
    );

    // Row 12 — Partial object.
    it('row 12 — missing OPTIONAL reasoning is recovered (defaults to empty)', () => {
        const r = sanitizeFindingsResult({
            suggestions: [validItem()],
        } as any);
        expect(r).not.toBeNull();
        expect(r!.reasoning).toBe('');
        expect(r!.suggestions).toHaveLength(1);
    });
    it('row 12 — an item missing a REQUIRED field is dropped, no crash', () => {
        const r = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                validItem(),
                { relevantFile: 'b.ts', suggestionContent: 'x', existingCode: 'y' }, // no improvedCode
            ],
        } as any);
        expect(r).not.toBeNull();
        expect(r!.suggestions).toHaveLength(1);
        expect(r!.suggestions[0].relevantFile).toBe('a.ts');
    });

    // Row 13 — Extra unknown keys are tolerated (stripped), never a crash.
    it('row 13 — extra unknown keys are tolerated at both levels', () => {
        const r = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [validItem({ weird: 'x', nested: { a: 1 } })],
            topLevelExtra: 'ignored',
        } as any);
        expect(r).not.toBeNull();
        expect(r!.suggestions).toHaveLength(1);
        expect(r!.suggestions[0].relevantFile).toBe('a.ts');
    });

    // Row 14 — Empty object {}: typed-empty WITH an explicit signal
    // (__findingsOutcome = 'artifact-unusable') — not a silent default.
    it('row 14 — empty-object submitResult yields typed-empty + explicit signal', () => {
        expect(sanitizeFindingsResult({} as any)).toBeNull();
        const state = mkState({ artifacts: [finderArtifact({})] });
        const out = extractFindings(state);
        expect(out).toEqual({ reasoning: '', suggestions: [] });
        expect((state as any).__findingsOutcome).toBe('artifact-unusable');
    });

    // Row 15 — Empty array: a legitimate "reviewed, found nothing".
    it('row 15 — empty suggestions array is preserved as a clean empty result', () => {
        const r = sanitizeFindingsResult({ reasoning: 'clean', suggestions: [] });
        expect(r).toEqual({ reasoning: 'clean', suggestions: [] });
        const state = mkState({
            artifacts: [finderArtifact({ reasoning: 'clean', suggestions: [] })],
        });
        expect((state && extractFindings(state)).suggestions).toEqual([]);
        expect((state as any).__findingsOutcome).toBe('structured');
    });

    // Row 16 — Empty / whitespace-only string.
    it('row 16 — empty and whitespace-only payloads return null / typed-empty', () => {
        expect(sanitizeFindingsResult('' as any)).toBeNull();
        expect(sanitizeFindingsResult('   \n\t ' as any)).toBeNull();
        const state = mkState({ steps: [stepText('   \n  ')] });
        expect(extractFindings(state)).toEqual({ reasoning: '', suggestions: [] });
    });

    // Row 17 — null / undefined.
    it('row 17 — null/undefined return null (never a crash)', () => {
        expect(sanitizeFindingsResult(null)).toBeNull();
        expect(sanitizeFindingsResult(undefined as any)).toBeNull();
        const state = mkState({ artifacts: [finderArtifact(null)] });
        expect(extractFindings(state)).toEqual({ reasoning: '', suggestions: [] });
    });

    // Row 18 — Primitive where an object is expected.
    it('row 18 — primitive payloads return null explicitly, no crash', () => {
        expect(sanitizeFindingsResult(true as any)).toBeNull();
        expect(sanitizeFindingsResult(0 as any)).toBeNull();
        expect(sanitizeFindingsResult('ok' as any)).toBeNull();
    });

    // Row 20 — Reasoning/thinking leak: findings written as PROSE in `reasoning`
    // with `suggestions` omitted (the Anthropic omission mode). RECOVERED via the
    // injected prose-recoverer wired by the adapter.
    it('row 20 — prose-only findings are recovered via the prose recoverer', async () => {
        const state = mkState({
            artifacts: [
                finderArtifact({
                    reasoning:
                        'There is a null-pointer bug in a.ts:10 that should be fixed.',
                    suggestions: [],
                }),
            ],
        });
        const recover = jest.fn(async () => [validItem()]);
        const out = await extractFindingsWithRecovery(state, recover as any);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(out.suggestions).toHaveLength(1);
    });

    // The finder findings seam ALWAYS returns the declared {reasoning, suggestions}
    // type — never undefined — across every layer.
    it('always returns the declared {reasoning, suggestions} type', () => {
        for (const payload of [
            null,
            {},
            true,
            [validItem()],
            { reasoning: 'r', suggestions: [validItem()] },
            'garbage',
        ]) {
            const out = extractFindings(
                mkState({ artifacts: [finderArtifact(payload)] }),
            );
            expect(typeof out.reasoning).toBe('string');
            expect(Array.isArray(out.suggestions)).toBe(true);
        }
    });
});

describe('contract matrix — B. semantic-but-wrong', () => {
    // Rows 21-23 apply to the VERIFIER verdict seam (D = {keep, rationale}); the
    // findings schema has no boolean field. extractVerdict requires a STRICT
    // boolean `keep`; any other encoding falls through to the default keep:true.
    // A verdict meaning "drop" that is encoded off-type is therefore SILENTLY
    // KEPT (verifier.agent.ts:143) — the #1786 class for the verify gate.

    // Row 21 — boolean as string ("false").
    it.failing(
        'row 21 — keep:"false" (string) must drop, not silently default to keep',
        () => {
            const v = extractVerdict(
                mkState({
                    artifacts: [
                        verdictArtifact({ keep: 'false', rationale: 'refuted' }),
                    ],
                }),
            );
            expect(v.keep).toBe(false); // fails today (defaults to true)
        },
    );

    // Row 22 — boolean as yes/no.
    it.failing(
        'row 22 — keep:"no" must drop, not silently default to keep',
        () => {
            const v = extractVerdict(
                mkState({
                    artifacts: [
                        verdictArtifact({ keep: 'no', rationale: 'refuted' }),
                    ],
                }),
            );
            expect(v.keep).toBe(false); // fails today (defaults to true)
        },
    );

    // Row 23 — boolean as number (0).
    it.failing(
        'row 23 — keep:0 must drop, not silently default to keep',
        () => {
            const v = extractVerdict(
                mkState({
                    artifacts: [verdictArtifact({ keep: 0, rationale: 'refuted' })],
                }),
            );
            expect(v.keep).toBe(false); // fails today (defaults to true)
        },
    );

    // A genuine boolean verdict is honored both ways (the happy semantic path).
    it('row 21-23 baseline — a real boolean keep:false is honored', () => {
        const v = extractVerdict(
            mkState({
                artifacts: [verdictArtifact({ keep: false, rationale: 'refuted' })],
            }),
        );
        expect(v.keep).toBe(false);
    });

    // Row 24 — enum out of the allowed set (severity:"URGENT"). PROD: the whole
    // (otherwise valid) finding is dropped because an OPTIONAL enum field is
    // present-but-invalid (findings-schema.ts suggestionSchema). Losing a real
    // finding over a label typo is a silent degradation → correct = keep it.
    it.failing(
        'row 24 — an out-of-set severity must not drop the whole finding',
        () => {
            const r = sanitizeFindingsResult({
                reasoning: 'r',
                suggestions: [validItem({ severity: 'URGENT' })],
            } as any);
            expect(r).not.toBeNull();
            expect(r!.suggestions).toHaveLength(1); // fails today (dropped → 0)
        },
    );

    // Row 26 — duplicate keys in the JSON object: JSON.parse is last-wins; the
    // text seam handles it without crashing.
    it('row 26 — duplicate JSON keys resolve last-wins, no crash', () => {
        const state = mkState({
            steps: [
                stepText(
                    '{"reasoning":"first","reasoning":"second","suggestions":[]}',
                ),
            ],
        });
        const out = extractFindings(state);
        expect(out.reasoning).toBe('second');
        expect(out.suggestions).toEqual([]);
    });

    // Row 27 — unicode / escaped newlines / emoji inside string fields survive.
    it('row 27 — unicode/emoji/newlines in string fields are preserved', () => {
        const content = 'race 🚀 在 handler\nwith escaped\ttabs — 你好';
        const r = sanitizeFindingsResult({
            reasoning: 'r 🚀',
            suggestions: [validItem({ suggestionContent: content })],
        } as any);
        expect(r).not.toBeNull();
        expect(r!.suggestions[0].suggestionContent).toBe(content);
        expect(r!.reasoning).toBe('r 🚀');
    });
});

describe('contract matrix — C. unparseable / transport (fail-safe)', () => {
    // Row 28 — truncated JSON (max_tokens mid-object): degrades to typed-empty,
    // never throws past the seam.
    it('row 28 — truncated JSON degrades to typed-empty, no throw', () => {
        const state = mkState({
            steps: [stepText('{"reasoning":"r","suggestions":[{"relevantFile":"a.ts",')],
        });
        expect(() => extractFindings(state)).not.toThrow();
        expect(extractFindings(state)).toEqual({ reasoning: '', suggestions: [] });
    });

    // Row 29 — malformed JSON.
    it('row 29 — trailing-comma JSON is repaired; single-quote JSON degrades', () => {
        // Trailing comma → deterministic repair recovers it.
        const ok = extractFindings(
            mkState({
                steps: [
                    stepText(
                        '{"reasoning":"r","suggestions":[' +
                            JSON.stringify(validItem()) +
                            ',]}',
                    ),
                ],
            }),
        );
        expect(ok.suggestions).toHaveLength(1);
        // Single quotes / unquoted keys are not JSON → typed-empty, no throw.
        const bad = mkState({
            steps: [stepText("{reasoning: 'r', suggestions: []}")],
        });
        expect(() => extractFindings(bad)).not.toThrow();
        expect(extractFindings(bad)).toEqual({ reasoning: '', suggestions: [] });
    });

    // Row 30 — LLM.run throws.
    // (a) The prose-recovery LLM.run is wrapped: a throw yields [] (never breaks
    //     the review) and the byokConfig is threaded to it.
    it('row 30a — recoverFindingsFromProse fails safe when LLM.run throws', async () => {
        const spy = jest
            .spyOn(LLM, 'run')
            .mockRejectedValue(new Error('network boom'));
        const prose =
            'There is a null-pointer bug in a.ts:10 that should be fixed ' +
            'because the value can be undefined and would crash the handler.';
        const byokConfig: any = { model: 'kimi-k2', main: { model: 'kimi-k2' } };
        const out = await recoverFindingsFromProse(prose, byokConfig, 'org', 'rn');
        expect(out).toEqual([]);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ byokConfig }),
        );
        spy.mockRestore();
    });
    // (b) End-to-end: a model throw becomes an error-status result, surfaced as
    //     errorMessage — the boundary resolves, never throws past itself.
    it('row 30b — a model throw resolves to an error-flagged output, no throw', async () => {
        const model = new MockLanguageModelV3({
            doGenerate: (async () => {
                throw new Error('network boom');
            }) as any,
        });
        const out = await runAgentLoopViaCore(makeInput(model), secrets);
        assertAgentLoopOutputShape(out);
        expect(out.finishReason).toBe('error');
        expect(out.errorMessage).toContain('network boom');
        expect(out.source).toBe('empty');
        expect(out.findings.suggestions).toEqual([]);
    });

    // Row 31 — an {error:...} object returned instead of a throw.
    it('row 31 — an {error} payload degrades to typed-empty + explicit signal', () => {
        const state = mkState({
            artifacts: [finderArtifact({ error: 'quota exceeded' })],
        });
        expect(extractFindings(state)).toEqual({ reasoning: '', suggestions: [] });
        expect((state as any).__findingsOutcome).toBe('artifact-unusable');
    });

    // Row 32 — empty success (content:'' / finish_reason:'length').
    it('row 32 — empty-content success degrades to typed-empty, no throw', async () => {
        const model = new MockLanguageModelV3({
            doGenerate: (async () => ({
                content: [],
                finishReason: 'length',
                usage: { inputTokens: 1, outputTokens: 0 },
                warnings: [],
            })) as any,
        });
        const out = await runAgentLoopViaCore(
            makeInput(model, { maxSteps: 1 }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
        expect(out.source).toBe('empty');
        expect(out.findings.suggestions).toEqual([]);
    });

    // Row 33 — refusal ("I cannot help…"): the prose-recovery gate rejects it
    // (no LLM spend) and the text seam finds no JSON → typed-empty.
    it('row 33 — a refusal is not mistaken for findings and degrades to empty', async () => {
        const spy = jest.spyOn(LLM, 'run');
        const out = await recoverFindingsFromProse(
            'I cannot help with that request.',
            undefined,
            'org',
        );
        expect(out).toEqual([]);
        expect(spy).not.toHaveBeenCalled(); // gate skipped the LLM entirely
        spy.mockRestore();
        const state = mkState({
            steps: [stepText('I cannot help with that request.')],
        });
        expect(extractFindings(state)).toEqual({ reasoning: '', suggestions: [] });
    });

    // Row 34 — abort signal fired: the boundary resolves with a valid output
    // (fail-safe) instead of crashing.
    it('row 34 — an already-aborted parentSignal does not crash the boundary', async () => {
        const ac = new AbortController();
        ac.abort();
        const out = await runAgentLoopViaCore(
            makeInput(makeModel().model, { parentSignal: ac.signal }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
    });
});

describe('contract matrix — D. input variants (invariant + return-shape)', () => {
    // Row 35 — empty input (0 changed files).
    it('row 35 — empty changedFiles returns a valid output, 0 coverage targets', async () => {
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), { changedFiles: [] }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
        expect(out.coverage.totalTargets).toBe(0);
        expect(out.findings.suggestions).toEqual([]);
    });

    // Row 36 — single item.
    it('row 36 — a single changed file is handled', async () => {
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), {
                changedFiles: [{ filename: 'only.ts', patch: '@@ -1 +1 @@\n+x' }],
            }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
        expect(out.coverage.totalTargets).toBe(1);
    });

    // Row 37 — large input crossing the compression/window boundary.
    it('row 37 — a large input under a small window still returns valid output', async () => {
        const changedFiles = Array.from({ length: 60 }, (_, i) => ({
            filename: `f${i}.ts`,
            patch: '@@ -1 +1 @@\n+' + 'x'.repeat(500),
        }));
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), {
                changedFiles,
                contextWindowTokens: 4000,
                systemPrompt: 'find bugs '.repeat(2000),
            }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
        expect(out.coverage.totalTargets).toBe(60);
    });

    // Row 38 — duplicate items in input (same filename twice).
    it('row 38 — duplicate changed files do not crash the boundary', async () => {
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), {
                changedFiles: [
                    { filename: 'dup.ts', patch: '+x' },
                    { filename: 'dup.ts', patch: '+x' },
                ],
            }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
        expect(out.coverage.totalTargets).toBe(2);
    });

    // Row 39 — item with null/undefined required fields.
    it('row 39 — changed file with null/undefined fields does not crash', async () => {
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), {
                changedFiles: [{ filename: undefined, patch: null }],
            }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
    });

    // Row 40 — special chars / whitespace-only / unicode diff.
    it('row 40 — special-char / whitespace-only patch does not crash', async () => {
        const out = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), {
                changedFiles: [
                    { filename: 'a.ts', patch: '   \n\t 你好 🚀 \n' },
                    { filename: 'b.ts', patch: '' },
                ],
            }),
            secrets,
        );
        assertAgentLoopOutputShape(out);
    });

    // Row 41 — the window branch boundary (off-by-one edge): the adapter switches
    // between the plain runner (no window) and the OverflowRecoveringRunner (window
    // set); a 1-token window exercises the tightest edge. Both must return valid.
    it('row 41 — both window branches (absent and 1-token) return valid output', async () => {
        const withoutWindow = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), { contextWindowTokens: undefined }),
            secrets,
        );
        assertAgentLoopOutputShape(withoutWindow);
        const tinyWindow = await runAgentLoopViaCore(
            makeInput(happyEmptyModel(), { contextWindowTokens: 1 }),
            secrets,
        );
        assertAgentLoopOutputShape(tinyWindow);
    });

    // Row 42 — order permutation is metamorphic: the kept/dropped decision set is
    // independent of the changed-file order.
    it('row 42 — changed-file order does not change the findings decision set', async () => {
        const filesAB = [
            { filename: 'a.ts', patch: '@@ -1 +1 @@\n+const x=1;' },
            { filename: 'b.ts', patch: '@@ -1 +1 @@\n+const y=2;' },
        ];
        const outAB = await runAgentLoopViaCore(
            makeInput(makeModel().model, { changedFiles: filesAB }),
            secrets,
        );
        const outBA = await runAgentLoopViaCore(
            makeInput(makeModel().model, { changedFiles: [...filesAB].reverse() }),
            secrets,
        );
        const keptOf = (o: any) =>
            o.findings.suggestions.map((s: any) => s.relevantFile).sort();
        const droppedOf = (o: any) =>
            o.droppedByVerify.map((s: any) => s.relevantFile).sort();
        expect(keptOf(outAB)).toEqual(keptOf(outBA));
        expect(droppedOf(outAB)).toEqual(droppedOf(outBA));
    });
});

describe('contract matrix — E. N-model policy (strict json_schema vs fallback)', () => {
    // The adapter's model-policy seam is supportsStrictToolsForRun, derived from
    // the resolved slot's model id (specModelId = byokConfig?.model ?? 'resolved')
    // and its failover target. On the strict branch the done-tool is grammar-
    // constrained so the model cannot emit off-schema; on the fallback branch the
    // full A/B/C zoo is in scope and the parse layer above must not degrade.

    // Strict branch — Gemini activates VALIDATED strict tool use (the only family
    // this adapter enables; see model-strictness.ts).
    it('row E-strict — Gemini gets strict tool use (trusts clean D at the source)', () => {
        expect(supportsStrictToolsForRun('gemini-2.5-pro')).toBe(true);
        expect(supportsStrictToolsForRun('gemini-3.1-pro')).toBe(true);
    });

    // json_object fallback branch — every other provider (incl. the gate's
    // strict-json_schema list openai/anthropic/moonshotai, which this adapter still
    // runs best-effort for tools) is NOT strict → the parse-layer zoo stays in scope.
    it('row E-fallback — non-Gemini models run best-effort (full zoo in scope)', () => {
        for (const id of [
            'openai:gpt-4o',
            'anthropic:claude-sonnet-4',
            'moonshotai/kimi-k2',
            'kimi-k2',
            'glm-4.6',
            'deepseek-chat',
            'z-ai/glm-4.6',
            'resolved',
        ]) {
            expect(supportsStrictToolsForRun(id)).toBe(false);
        }
    });

    // Failover swap: strict is dropped if the fallback target can't honor it
    // (a strict tool built for Gemini would be rejected by an OpenAI fallback).
    it('row E-failover — Gemini primary + OpenAI fallback disables strict', () => {
        expect(
            supportsStrictToolsForRun('gemini-2.5-pro', 'openai:gpt-4o'),
        ).toBe(false);
        expect(
            supportsStrictToolsForRun('gemini-2.5-pro', 'gemini-3.1-pro'),
        ).toBe(true);
    });

    // The parse layer is MODEL-INDEPENDENT: the same off-schema wrapper degrades
    // identically whether the slot is a strict (Gemini) or a fallback (Kimi) model
    // — the boundary never blind-trusts clean D based on the model id. Proven
    // end-to-end through the adapter with a wrapper-shaped submitResult payload.
    it('row E — an off-schema wrapper degrades identically across model branches', async () => {
        const wrapper = { result: { reasoning: 'r', suggestions: [validItem()] } };
        const geminiOut = await runAgentLoopViaCore(
            makeInput(modelReturningFindings(wrapper)),
            {
                ...secrets,
                byokConfig: { model: 'gemini-2.5-pro' } as any,
            },
        );
        const kimiOut = await runAgentLoopViaCore(
            makeInput(modelReturningFindings(wrapper)),
            {
                ...secrets,
                byokConfig: { model: 'kimi-k2' } as any,
            },
        );
        // Same silent-drop degradation regardless of model policy (row 4 class).
        expect(geminiOut.findings.suggestions).toEqual([]);
        expect(kimiOut.findings.suggestions).toEqual([]);
        assertAgentLoopOutputShape(geminiOut);
        assertAgentLoopOutputShape(kimiOut);
    });

    // Request assembly / threading: the adapter forwards secrets.byokConfig into
    // the prose-recovery boundary. That boundary's byokConfig threading is proven
    // directly by row 30a (recoverFindingsFromProse called with byokConfig) — the
    // e2e cannot spy LLM.run here without breaking the finder's own model calls
    // (the runner uses the SAME LLM.run door), so the contract is pinned at the
    // recovery unit above rather than duplicated as a flaky e2e assertion.
});
