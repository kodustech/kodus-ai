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

import {
    finderRunEnvironment,
    runAgentLoopViaCore,
} from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
// The finder findings parse (sanitizeFindingsResult / extractFindings) has its
// own matrix in finder.agent.spec.ts and findings-schema.spec.ts; this file
// keeps the verifier verdict seam and the end-to-end adapter path.
import { extractVerdict } from '@libs/code-review/infrastructure/agents/core/verifier.agent';

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
    it('verifies on the check slot when one differs from the run slot', async () => {
        const { model } = makeModel();
        const input = makeInput(model);
        const runSlot = { provider: 'openai', model: 'run-model' };
        const checkSlot = { provider: 'anthropic', model: 'check-model' };

        const out = await runAgentLoopViaCore(input, {
            ...secrets,
            byokConfig: runSlot,
            verifyByokConfig: checkSlot,
        });

        expect(out.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'b.ts',
        ]);
        const slotsCalled = mockResolve.mock.calls.map(([slot]) => slot?.model);
        expect(slotsCalled).toContain('run-model');
        expect(slotsCalled).toContain('check-model');
    });

    it('keeps verify on the run slot when the check slot is the same model', async () => {
        const { model } = makeModel();
        const input = makeInput(model);
        mockResolve.mockClear();
        const runSlot = { provider: 'openai', model: 'run-model' };

        await runAgentLoopViaCore(input, {
            ...secrets,
            byokConfig: runSlot,
            verifyByokConfig: { ...runSlot },
        });

        const slotsCalled = mockResolve.mock.calls.map(([slot]) => slot);
        expect(slotsCalled.every((slot) => slot === runSlot)).toBe(true);
    });

    it('runs finder + verify end-to-end and maps RunState -> AgentLoopOutput', async () => {
        const { model } = makeModel();
        const out = await runAgentLoopViaCore(makeInput(model), secrets);

        // verify funnel: 2 found, FP refuted -> 1 kept, 1 dropped
        expect(
            out.findings.suggestions.map((s: any) => s.relevantFile),
        ).toEqual(['a.ts']);
        expect(out.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'b.ts',
        ]);
        expect(out.verification?.beforeCount).toBe(2);
        expect(out.verification?.afterCount).toBe(1);
        expect(out.verification?.droppedByVerifier).toBe(1);
        expect(typeof out.verification?.verifyMs).toBe('number');

        // A dropped finding keeps its text in the trace so it can be judged
        // later; a kept one travels on as a finding and carries none.
        const decisions = out.verification?.decisions ?? [];
        const drop = decisions.find((d) => d.action === 'drop');
        expect(drop?.relevantFile).toBe('b.ts');
        expect(drop?.droppedFinding).toMatchObject({
            suggestionContent: expect.any(String),
        });
        expect(
            decisions.find((d) => d.action === 'keep')?.droppedFinding,
        ).toBeUndefined();

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
//  LLM.run I/O CONTRACT MATRIX — the verifier verdict seam (extractVerdict) and
//  the fail-safe / return-shape layers of the adapter boundary. Rows that
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
const verdictArtifact = (payload: unknown) => ({
    type: 'submitVerdict',
    payload,
});

/** A model that finalizes with EXACTLY the given submitResult payload object
 *  (drives the off-schema shape through the real harness end-to-end). */
function modelReturningFindings(payload: unknown) {
    // The verifier gets a verdict: one that never answers ends unverified, and
    // its findings are not published (#2171).
    return new MockLanguageModelV3({
        doGenerate: (async (opts: any) => ({
            content: [
                /REFUTE|verdict/.test(JSON.stringify(opts?.prompt ?? ''))
                    ? {
                          type: 'tool-call',
                          toolCallId: 'v',
                          toolName: 'submitVerdict',
                          input: JSON.stringify({
                              keep: true,
                              rationale: 'ok',
                          }),
                      }
                    : {
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
    expect(
        out.verification === null || typeof out.verification === 'object',
    ).toBe(true);
    expect(out.verificationUsage).toBeDefined();
}

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
                        verdictArtifact({
                            keep: 'false',
                            rationale: 'refuted',
                        }),
                    ],
                }),
            );
            expect(v.keep).toBe(false); // fails today (defaults to true)
        },
    );

    // A genuine boolean verdict is honored both ways (the happy semantic path).
    it('row 21-23 baseline — a real boolean keep:false is honored', () => {
        const v = extractVerdict(
            mkState({
                artifacts: [
                    verdictArtifact({ keep: false, rationale: 'refuted' }),
                ],
            }),
        );
        expect(v.keep).toBe(false);
    });
});

describe('contract matrix — C. unparseable / transport (fail-safe)', () => {
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
            makeInput(makeModel().model, {
                changedFiles: [...filesAB].reverse(),
            }),
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

describe('runAgentLoopViaCore — model policy and threaded review context', () => {
    // The parse layer is MODEL-INDEPENDENT: the same off-schema wrapper degrades
    // identically whether the slot is a strict (Gemini) or a fallback (Kimi) model
    // — the boundary never blind-trusts clean D based on the model id. Proven
    // end-to-end through the adapter with a wrapper-shaped submitResult payload.
    it('row E — an off-schema wrapper degrades identically across model branches', async () => {
        const wrapper = {
            result: { reasoning: 'r', suggestions: [validItem()] },
        };
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
        // Recovers identically regardless of model policy: the SHAPE fix
        // (normalizeEnvelope) is model-agnostic, so a {result:D} wrapper is
        // unwrapped for both the strict-json_schema and the json_object-fallback
        // model — no more silent drop (row 4 class, #1786).
        expect(geminiOut.findings.suggestions).toHaveLength(1);
        expect(kimiOut.findings.suggestions).toHaveLength(1);
        assertAgentLoopOutputShape(geminiOut);
        assertAgentLoopOutputShape(kimiOut);
    });

    // Team systems (#2172): AgentLoopInput.teamSystemTools reaches the
    // synthesis rescue, which asks about requirements a consulted system states.
    it('threads teamSystemTools to the recall pass prompt, and nothing without them', async () => {
        const recallPrompts = async (over: Record<string, unknown>) => {
            const prompts: string[] = [];
            const doGenerate = (async (opts: any) => {
                prompts.push(JSON.stringify(opts?.prompt ?? ''));
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'f',
                            toolName: 'submitResult',
                            input: JSON.stringify({
                                reasoning: 'nothing',
                                suggestions: [],
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }) as any;
            await runAgentLoopViaCore(
                makeInput(new MockLanguageModelV3({ doGenerate }), {
                    reviewMode: undefined,
                    ...over,
                }),
                secrets,
            );
            return prompts;
        };
        const question =
            'Did a team system you consulted state a requirement this change breaks?';

        const withSystems = await recallPrompts({
            teamSystemTools: ['Tracker__get_issue'],
        });
        const without = await recallPrompts({});

        expect(withSystems.length).toBeGreaterThan(1);
        expect(withSystems.some((p) => p.includes(question))).toBe(true);
        expect(without.some((p) => p.includes(question))).toBe(false);
    });

    // Previous review decisions (issue #1313): proves the REAL wiring end to
    // end — AgentLoopInput.previousDecisions -> runFinderWithVerify ->
    // LlmVerifier -> verifierPromptFor — not just the unit-level forwarding
    // already pinned in verifier.agent.contract.spec.ts. This is the actual
    // reported symptom: the finder (no memory of its own) proposes the OPPOSITE
    // of a decision it already applied on a prior review round; the verifier,
    // given that decision as evidence, refutes it.
    it('threads previousDecisions to the verifier, which refutes a finding contradicting an already-applied decision', async () => {
        const doGenerate = (async (opts: any) => {
            const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
            const isVerifier =
                sys.includes('REFUTE') ||
                sys.includes('verdict') ||
                sys.includes('verify');

            if (isVerifier) {
                // The verifier only sees this evidence because the adapter
                // threaded previousDecisions all the way down — if any hop in
                // the chain silently dropped the field, this string would be
                // absent and the test would refute nothing (keep:true, findings
                // survive), catching a regression at ANY of the hops.
                const sawPriorDecision =
                    sys.includes('PreviousReviewDecisions') &&
                    sys.includes('Use const instead of let');
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'v',
                            toolName: 'submitVerdict',
                            input: JSON.stringify(
                                sawPriorDecision
                                    ? {
                                          keep: false,
                                          rationale:
                                              'refuted: contradicts an already-applied decision',
                                      }
                                    : { keep: true, rationale: 'no evidence' },
                            ),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }

            // Finder: proposes the OPPOSITE of the previously-applied decision.
            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'f',
                        toolName: 'submitResult',
                        input: JSON.stringify({
                            reasoning: 'one candidate',
                            suggestions: [
                                {
                                    relevantFile: 'a.ts',
                                    suggestionContent:
                                        'Use let instead of const.',
                                    existingCode: 'const x = 1;',
                                    improvedCode: 'let x = 1;',
                                    severity: 'low',
                                },
                            ],
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
                previousDecisions: [
                    {
                        suggestionId: 'sug-1',
                        relevantFile: 'a.ts',
                        suggestionContent: 'Use const instead of let.',
                        label: 'bug',
                        outcome: 'implemented',
                        decidedAt: '2026-01-01T00:00:00.000Z',
                    },
                ],
            }),
            secrets,
        );

        expect(out.findings.suggestions).toHaveLength(0);
        expect(out.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'a.ts',
        ]);
    });

    // A repo_instruction finding is judged against the repository's
    // coding-agent instructions; without them the verifier drops it as style.
    it('threads repoInstructions to the verifier for a repo_instruction finding', async () => {
        const doGenerate = (async (opts: any) => {
            const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
            const isVerifier =
                sys.includes('REFUTE') ||
                sys.includes('verdict') ||
                sys.includes('verify');
            const tc = isVerifier
                ? {
                      id: 'v',
                      name: 'submitVerdict',
                      input: sys.includes('Money columns end in _cents.')
                          ? { keep: true, rationale: 'breaks CLAUDE.md' }
                          : { keep: false, rationale: 'style only' },
                  }
                : {
                      id: 'f',
                      name: 'submitResult',
                      input: {
                          reasoning: 'one candidate',
                          suggestions: [
                              {
                                  relevantFile: 'a.ts',
                                  label: 'repo_instruction',
                                  suggestionContent:
                                      'CLAUDE.md says "Amounts are integer cents."',
                                  existingCode: 'const total = 1.5;',
                                  improvedCode: 'const totalCents = 150;',
                                  severity: 'medium',
                              },
                          ],
                      },
                  };
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

        const out = await runAgentLoopViaCore(
            makeInput(new MockLanguageModelV3({ doGenerate }), {
                repoInstructions: {
                    files: [
                        {
                            path: 'CLAUDE.md',
                            content:
                                'Amounts are integer cents. Money columns end in _cents.',
                            appliesTo: '**',
                            truncated: false,
                        },
                    ],
                    otherFiles: [],
                    dropped: [],
                    truncated: false,
                    indexedCount: 1,
                },
            }),
            secrets,
        );

        expect(out.droppedByVerify).toHaveLength(0);
        expect(out.findings.suggestions.map((s: any) => s.relevantFile)).toEqual([
            'a.ts',
        ]);
    });

    describe('readRepoInstruction', () => {
        const repoInstructions = {
            files: [
                {
                    path: 'CLAUDE.md',
                    content: 'Amounts are integer cents.',
                    appliesTo: '**',
                    truncated: false,
                },
            ],
            otherFiles: [],
            dropped: [],
            truncated: false,
            indexedCount: 1,
        };

        /** Finder calls readRepoInstruction once when offered, then submits;
         *  records the tool names offered and the prompts it saw. */
        function readingModel() {
            const seen = { tools: [] as string[][], prompts: [] as string[] };
            const doGenerate = (async (opts: any) => {
                const sys = JSON.stringify(opts?.prompt ?? '');
                const offered = (opts?.tools ?? []).map((t: any) => t.name);
                const isVerifier = offered.includes('submitVerdict');
                if (!isVerifier) {
                    seen.tools.push(offered);
                    seen.prompts.push(sys);
                }
                const tc = isVerifier
                    ? {
                          id: 'v',
                          name: 'submitVerdict',
                          input: { keep: true, rationale: 'ok' },
                      }
                    : offered.includes('readRepoInstruction') &&
                        !sys.includes('tool-result')
                      ? {
                            id: 'r',
                            name: 'readRepoInstruction',
                            input: { path: 'CLAUDE.md' },
                        }
                      : { id: 'f', name: 'submitResult', input: findings };
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: tc.id,
                            toolName: tc.name,
                            input: JSON.stringify(tc.input),
                        },
                    ],
                    // Structured, or the SDK reads the reason as unknown and
                    // leaves the tool call unexecuted.
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }) as any;
            return { model: new MockLanguageModelV3({ doGenerate }), seen };
        }

        it('is offered when the prompt lists the instructions, and answers with the file text', async () => {
            const { model, seen } = readingModel();
            await runAgentLoopViaCore(
                makeInput(model, {
                    repoInstructions,
                    listsRepoInstructions: true,
                }),
                secrets,
            );
            expect(seen.tools[0]).toContain('readRepoInstruction');
            expect(
                seen.prompts.some((p) =>
                    p.includes('Amounts are integer cents.'),
                ),
            ).toBe(true);
        });

        it('is offered without a sandbox', async () => {
            const { model, seen } = readingModel();
            await runAgentLoopViaCore(
                makeInput(model, {
                    repoInstructions,
                    listsRepoInstructions: true,
                }),
                { ...secrets, remoteCommands: undefined },
            );
            expect(seen.tools[0]).toContain('readRepoInstruction');
        });

        it('is not offered to an agent whose prompt does not list them', async () => {
            const { model, seen } = readingModel();
            await runAgentLoopViaCore(
                makeInput(model, { repoInstructions }),
                secrets,
            );
            expect(seen.tools.flat()).not.toContain('readRepoInstruction');
        });

        // Without a sandbox the heavy passes are skipped; the instructions
        // tool must not turn them back on.
        it('keeps a review without a sandbox off the heavy passes', async () => {
            const plain = makeModel();
            await runAgentLoopViaCore(
                makeInput(plain.model, { reviewMode: 'normal' }),
                { ...secrets, remoteCommands: undefined },
            );
            const listed = makeModel();
            await runAgentLoopViaCore(
                makeInput(listed.model, {
                    reviewMode: 'normal',
                    repoInstructions,
                    listsRepoInstructions: true,
                }),
                { ...secrets, remoteCommands: undefined },
            );
            expect(listed.calls.count).toBe(plain.calls.count);
        });
    });

    // Lane check (#2172): AgentLoopInput.laneFocus reaches the verifier, which
    // drops a custom agent's finding outside its focus in the verify run the
    // finding already takes; it is counted with the verify drops.
    it('threads laneFocus to the verifier, which drops a finding outside the focus', async () => {
        const runWith = async (over: Record<string, unknown>) => {
            const doGenerate = (async (opts: any) => {
                const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
                if (sys.includes('REFUTE')) {
                    const outOfFocus =
                        sys.includes('AgentFocus') &&
                        sys.includes('end-to-end test');
                    return {
                        content: [
                            {
                                type: 'tool-call',
                                toolCallId: 'v',
                                toolName: 'submitVerdict',
                                input: JSON.stringify(
                                    outOfFocus
                                        ? {
                                              keep: false,
                                              rationale:
                                                  'OUT OF FOCUS: a pagination bug',
                                          }
                                        : { keep: true, rationale: 'kept' },
                                ),
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
                                reasoning: 'one candidate',
                                suggestions: [
                                    {
                                        relevantFile: 'a.ts',
                                        suggestionContent:
                                            'The last page is skipped.',
                                        existingCode: 'const x=1;',
                                        improvedCode: 'const x=2;',
                                        severity: 'high',
                                    },
                                ],
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }) as any;
            return runAgentLoopViaCore(
                makeInput(new MockLanguageModelV3({ doGenerate }), over),
                secrets,
            );
        };

        const lane = await runWith({
            laneFocus:
                'Reviewer: "Booking E2E"\nInstructions:\nEvery booking screen needs an end-to-end test.',
        });
        const noLane = await runWith({});

        expect(lane.findings.suggestions).toHaveLength(0);
        expect(lane.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'a.ts',
        ]);
        expect(noLane.findings.suggestions).toHaveLength(1);
    });

    // The evidence gate's forceFull re-verify (finder.agent.ts's second,
    // unevidenced-only LlmVerifier instance) is a one-line duplicate of the
    // first pass's `previousDecisions` forwarding, but was never itself
    // exercised end-to-end — only the first-pass LlmVerifier was proven above.
    // Here the finder never calls readFile/checkTypes, so the kept finding is
    // always "unevidenced" and always reaches the gate; the first pass keeps
    // it unconditionally so the SECOND (forceFull) verifier call is the one
    // actually deciding, proving previousDecisions reached that instance too.
    it('threads previousDecisions to the evidence-gate forceFull re-verify too, not just the first pass', async () => {
        let verifierCalls = 0;
        const doGenerate = (async (opts: any) => {
            const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
            const isVerifier =
                sys.includes('REFUTE') ||
                sys.includes('verdict') ||
                sys.includes('verify');

            if (isVerifier) {
                verifierCalls += 1;
                const isFirstPass = verifierCalls === 1;
                const sawPriorDecision =
                    sys.includes('PreviousReviewDecisions') &&
                    sys.includes('Use const instead of let');
                // First pass always keeps (unevidenced) -> forces the gate.
                // The gate call is the one that actually refutes, and only
                // does so because it too received previousDecisions.
                const keep = isFirstPass || !sawPriorDecision;
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'v',
                            toolName: 'submitVerdict',
                            input: JSON.stringify({
                                keep,
                                rationale: keep
                                    ? 'kept'
                                    : 'refuted by the gate: contradicts an already-applied decision',
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
                            reasoning: 'one candidate',
                            suggestions: [
                                {
                                    relevantFile: 'a.ts',
                                    suggestionContent:
                                        'Use let instead of const.',
                                    existingCode: 'const x = 1;',
                                    improvedCode: 'let x = 1;',
                                    severity: 'low',
                                },
                            ],
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
                previousDecisions: [
                    {
                        suggestionId: 'sug-1',
                        relevantFile: 'a.ts',
                        suggestionContent: 'Use const instead of let.',
                        label: 'bug',
                        outcome: 'implemented',
                        decidedAt: '2026-01-01T00:00:00.000Z',
                    },
                ],
            }),
            secrets,
        );

        expect(verifierCalls).toBe(2); // first pass + forceFull gate
        expect(out.findings.suggestions).toHaveLength(0);
        expect(out.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'a.ts',
        ]);
    });
});

// Custom agents can link the same files as guides; their findings take the
// convention check, not the instruction-citation check.
describe('finderRunEnvironment — instruction citations', () => {
    it('checks them for built-in agents and not for custom agents', () => {
        const model = new MockLanguageModelV3({});
        expect(
            finderRunEnvironment(makeInput(model), secrets).verifyParams
                .checksInstructionCitations,
        ).toBe(true);
        expect(
            finderRunEnvironment(
                makeInput(model, { conventionGuides: [] }),
                secrets,
            ).verifyParams.checksInstructionCitations,
        ).toBe(false);
    });
});

describe('runAgentLoopViaCore — finder labels', () => {
    const labelsOffered = async (over: Record<string, unknown>) => {
        let enumOffered: string[] | undefined;
        const doGenerate = (async (opts: any) => {
            const submit = (opts?.tools ?? []).find(
                (t: any) => t.name === 'submitResult',
            );
            if (submit && !enumOffered) {
                const schema = submit.inputSchema ?? submit.parameters;
                enumOffered =
                    schema?.properties?.suggestions?.items?.properties?.label
                        ?.enum;
            }
            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'f',
                        toolName: 'submitResult',
                        input: JSON.stringify({
                            reasoning: 'r',
                            suggestions: [],
                        }),
                    },
                ],
                finishReason: 'tool-calls',
                usage: { inputTokens: 5, outputTokens: 5 },
                warnings: [],
            };
        }) as any;
        await runAgentLoopViaCore(
            makeInput(new MockLanguageModelV3({ doGenerate }), over),
            secrets,
        );
        return enumOffered;
    };

    it('offers only the labels the agent may report', async () => {
        expect(
            await labelsOffered({
                allowedLabels: ['bug', 'security', 'performance'],
            }),
        ).toEqual(['bug', 'security', 'performance']);
        expect(
            await labelsOffered({
                allowedLabels: [
                    'bug',
                    'security',
                    'performance',
                    'repo_instruction',
                ],
            }),
        ).toContain('repo_instruction');
    });
});
