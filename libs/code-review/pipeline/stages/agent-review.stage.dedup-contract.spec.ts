import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

// The dedup pass' post-LLM helpers (severity reclassification + content
// formatter) each make their OWN model calls. They are irrelevant to the
// DEDUP_SCHEMA parse boundary under test, so stub them to no-ops for the
// stage-level cases — the deduplicateSuggestions() unit cases never reach them.
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
// Keep every real export of managed-slot; only make hasManagedModelKey
// deterministic so the "no secondary model" branch does not depend on which
// provider env keys happen to be set in the test host.
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * CONTRACT tests for the LLM.run boundary in AgentReviewStage's dedup pass
 * (issue #1786).
 *
 * The dedup pass calls LLM.run with DEDUP_SCHEMA and reads `groups` / `unique`
 * off the parsed object. We support N models; the non-strict ones (kimi / glm /
 * deepseek / z-ai) fall back to json_object and can return the SAME information
 * in a DIFFERENT envelope — a bare array, a `{result:…}` wrapper, a stringified
 * blob, or the right data under the wrong keys. When that happens the current
 * code reads `undefined` for both `groups` and `unique`, folds into the
 * "empty → keep all" branch, and the dedup SILENTLY becomes a no-op: every
 * duplicate the model actually found ships as a duplicate PR comment.
 *
 * These tests pin three contract layers around the deterministic (non-model)
 * logic:
 *   1. HAPPY  — correct envelope ⇒ exact dedup + exact LLM.run request + the
 *               declared { suggestions, trace } return shape.
 *   2. OFF-SCHEMA / N-MODEL — the shapes non-strict models emit. Where the code
 *               degrades silently today the assertion is written with
 *               `it.failing` against the CORRECT (non-degrading) behavior: it is
 *               green now and flips to a real failure the day #1786 is fixed.
 *   3. FAIL-SAFE — LLM.run rejects (provider error / suspended key) ⇒ the
 *               documented fallback (dev/CI re-throws to fail loud; production
 *               keeps all with an explicit `failed-keep-all` reason), never a
 *               silent data drop.
 */
describe('AgentReviewStage — dedup LLM.run contract (#1786)', () => {
    const makeStage = () =>
        new AgentReviewStage(
            {} as any, // automationExecutionService
            {} as any, // repositoryService
            {} as any, // reviewOrchestrator
            {} as any, // observabilityService
            {} as any, // graphContext
            {} as any, // featureGate
            {} as any, // organizationService
            {} as any, // codeManagementService
        );

    const slot = { provider: 'openai', model: 'gpt-4o-mini' } as any;
    const telemetryMeta = {
        organizationId: 'org-1',
        teamId: 'team-1',
        pullRequestId: 7,
        repositoryId: 'repo-1',
    } as any;

    // Two suggestions with IDENTICAL descriptive text on the same file+lines.
    // Identical text drives the content-similarity guard (contentSimilarity=1)
    // straight to a lexical "honor", so an honored merge needs NO embedding /
    // tiebreak model call — the dedup outcome is fully deterministic.
    const dupA = () => ({
        relevantFile: 'src/user.ts',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'user object can be null and is dereferenced',
        suggestionContent: 'user object can be null and is dereferenced here',
        improvedCode: 'if (!user) return;',
    });
    const dupB = () => ({ ...dupA() });

    // Two clearly-distinct findings — never merged.
    const distinctX = () => ({
        relevantFile: 'src/a.ts',
        relevantLinesStart: 1,
        relevantLinesEnd: 2,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'off by one error in the pagination loop',
        suggestionContent: 'the pagination loop iterates one element too far',
        improvedCode: 'for (let i = 0; i < n; i++)',
    });
    const distinctY = () => ({
        relevantFile: 'src/b.ts',
        relevantLinesStart: 40,
        relevantLinesEnd: 41,
        label: 'security',
        severity: 'critical',
        oneSentenceSummary: 'sql query built via string concatenation',
        suggestionContent: 'concatenating user input into the sql string',
        improvedCode: 'db.query(sql, [param])',
    });

    let runSpy: jest.SpyInstance;

    afterEach(() => {
        runSpy?.mockRestore();
        jest.clearAllMocks();
    });

    const callDedup = (stage: AgentReviewStage, suggestions: any[]) =>
        (stage as any).deduplicateSuggestions(
            suggestions,
            7,
            slot,
            telemetryMeta,
        ) as Promise<{ suggestions: any[]; trace: any }>;

    // ── Layer 1: HAPPY PATH ────────────────────────────────────────────────
    describe('happy path — correct DEDUP_SCHEMA envelope', () => {
        it('merges a duplicate the model grouped, returning exactly one', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [{ keep: 0, duplicates: [1] }],
                unique: [],
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [dupA(), dupB()]);

            expect(out.suggestions).toHaveLength(1);
            expect(out.suggestions[0].oneSentenceSummary).toBe(
                dupA().oneSentenceSummary,
            );
            expect(out.trace.status).toBe('success');
            expect(out.trace.removedCount).toBe(1);
            expect(out.trace.nonKodyOutputCount).toBe(1);
        });

        it('keeps both when the model marks them unique', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [],
                unique: [0, 1],
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [distinctX(), distinctY()]);

            expect(out.suggestions).toHaveLength(2);
            expect(out.trace.status).toBe('success');
            expect(out.trace.removedCount).toBe(0);
            expect(out.trace.uniqueCount).toBe(2);
        });

        it('sends the pinned LLM.run request (schema, run/span name, byok attrs)', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [],
                unique: [0, 1],
            } as any);
            const stage = makeStage();

            await callDedup(stage, [distinctX(), distinctY()]);

            expect(runSpy).toHaveBeenCalledTimes(1);
            const req = runSpy.mock.calls[0][0];
            expect(req.byokConfig).toBe(slot);
            expect(req.schema).toBeTruthy(); // jsonSchema(DEDUP_SCHEMA) wrapper
            expect(typeof req.user).toBe('string');
            expect(req.runName).toBe('code-review-dedup');
            expect(req.spanName).toBe('code-review::dedup');
            expect(req.organizationId).toBe('org-1');
            expect(req.attrs).toEqual(
                expect.objectContaining({
                    type: 'byok', // a resolved slot ⇒ byok attribution
                    prNumber: 7,
                    teamId: 'team-1',
                }),
            );
        });

        it('always returns the declared { suggestions[], trace{status} } shape', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [{ keep: 0, duplicates: [1] }],
                unique: [],
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [dupA(), dupB()]);

            expect(Array.isArray(out.suggestions)).toBe(true);
            expect(out.trace).toEqual(
                expect.objectContaining({ status: expect.any(String) }),
            );
        });

        it('honors a partial-but-on-schema envelope (unique omitted)', async () => {
            // `{ groups }` with `unique` absent is still ON the envelope — the
            // reader defaults `unique` to [] and the group still merges.
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [{ keep: 0, duplicates: [1] }],
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [dupA(), dupB()]);

            expect(out.suggestions).toHaveLength(1);
            expect(out.trace.status).toBe('success');
        });
    });

    // ── Layer 2: OFF-SCHEMA / N-MODEL ROBUSTNESS (the #1786 class) ──────────
    describe('off-schema envelopes non-strict models emit (#1786)', () => {
        // An HONESTLY-empty or absent payload SHOULD keep all — there is no
        // dedup information to act on. The contract is that this is SIGNALLED
        // (explicit `empty-keep-all` reason), not silent, and no data is lost.
        it.each([
            ['null', null],
            ['empty object', {}],
        ])(
            'keeps all and signals empty-keep-all for %s (fail-safe, not silent)',
            async (_label, payload) => {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue(payload as any);
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                expect(out.suggestions).toHaveLength(2); // no data dropped
                expect(out.trace.status).toBe('empty-keep-all'); // explicit reason
            },
        );

        // The shapes below CARRY a real duplicate group, just in the wrong
        // envelope. The correct behavior is to repair/re-ask/signal so the
        // duplicate is still removed. Today the code reads `undefined` for
        // groups+unique and silently keeps BOTH — the duplicate ships. Each is
        // written with it.failing against the CORRECT outcome (one survivor):
        // green now, flips to red when #1786 is fixed.
        it.failing(
            'bare array [{keep,duplicates}] instead of {groups,unique} — should still dedup',
            async () => {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue([
                        { keep: 0, duplicates: [1] },
                    ] as any);
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                // CORRECT: the model found a duplicate; only one should survive.
                expect(out.suggestions).toHaveLength(1);
            },
        );

        it.failing(
            '{result:{groups,unique}} wrapper — should still dedup',
            async () => {
                runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                    result: { groups: [{ keep: 0, duplicates: [1] }], unique: [] },
                } as any);
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                expect(out.suggestions).toHaveLength(1);
            },
        );

        it.failing(
            'stringified JSON payload — should still dedup',
            async () => {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue(
                        JSON.stringify({
                            groups: [{ keep: 0, duplicates: [1] }],
                            unique: [],
                        }) as any,
                    );
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                expect(out.suggestions).toHaveLength(1);
            },
        );

        it.failing(
            'right data under wrong keys {duplicateGroups,uniqueIndices} — should still dedup',
            async () => {
                runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                    duplicateGroups: [{ keep: 0, duplicates: [1] }],
                    uniqueIndices: [],
                } as any);
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                expect(out.suggestions).toHaveLength(1);
            },
        );

        // A malformed-but-recognized envelope (indices out of range / omitted)
        // must NEVER drop a suggestion — the Layer-3 safety net re-adds any
        // index the model never classified. This is the non-degrading behavior
        // and passes today; pinned so a regression surfaces.
        it('re-adds suggestions the model omitted from groups+unique', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [],
                unique: [0], // index 1 never mentioned
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [distinctX(), distinctY()]);

            expect(out.suggestions).toHaveLength(2); // nothing silently dropped
        });

        it('does not drop on out-of-range indices in a valid envelope', async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                groups: [{ keep: 99, duplicates: [42] }], // both out of range
                unique: [],
            } as any);
            const stage = makeStage();

            const out = await callDedup(stage, [distinctX(), distinctY()]);

            expect(out.suggestions).toHaveLength(2);
        });
    });

    // ── Layer 3: FAIL-SAFE (LLM.run rejects) ───────────────────────────────
    describe('fail-safe when LLM.run rejects', () => {
        it('re-throws in dev/CI (fail loud, not a silent no-op)', async () => {
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockRejectedValue(new Error('provider 500 / suspended key'));
            const stage = makeStage();

            // API_NODE_ENV=test ⇒ non-production ⇒ deliberate re-throw so a
            // programming bug surfaces at PR time instead of shipping dupes.
            await expect(callDedup(stage, [dupA(), dupB()])).rejects.toThrow(
                'provider 500',
            );
        });

        it('keeps all with an explicit failed-keep-all reason in production', async () => {
            const prev = process.env.API_NODE_ENV;
            process.env.API_NODE_ENV = 'production';
            try {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockRejectedValue(new Error('provider boom'));
                const stage = makeStage();

                const out = await callDedup(stage, [dupA(), dupB()]);

                expect(out.suggestions).toHaveLength(2); // no data dropped
                expect(out.trace.status).toBe('failed-keep-all');
                expect(out.trace.errorMessage).toContain('provider boom');
            } finally {
                process.env.API_NODE_ENV = prev;
            }
        });

        it('skips the call and keeps all when there is no model (<=1 input short-circuits too)', async () => {
            runSpy = jest.spyOn(LLM, 'run');
            const stage = makeStage();

            // Single suggestion: never worth a model call, returns skipped.
            const out = await (stage as any).deduplicateSuggestions(
                [dupA()],
                7,
                slot,
                telemetryMeta,
            );

            expect(out.suggestions).toHaveLength(1);
            expect(out.trace.status).toBe('skipped');
            expect(runSpy).not.toHaveBeenCalled();
        });
    });
});

/**
 * Stage-level (executeStage) contract: the dedup boundary in its real place —
 * result assembly downstream of LLM.run, and the guarantee that a rejecting
 * dedup NEVER throws past the stage nor silently drops findings.
 */
describe('AgentReviewStage.executeStage — dedup assembly + fail-safe (#1786)', () => {
    const makeStage = (orchestratorResult: any) => {
        const reviewOrchestrator = {
            execute: jest.fn().mockResolvedValue(orchestratorResult),
        };
        const stage = new AgentReviewStage(
            { findLatestStageLog: jest.fn(), updateCodeReview: jest.fn() } as any,
            { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
            reviewOrchestrator as any,
            { runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()) } as any,
            {
                generateContext: jest.fn(),
                generateContextLegacy: jest.fn(),
            } as any,
            { isEnabled: jest.fn().mockResolvedValue(false) } as any,
            { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
            {
                getRepositories: jest.fn().mockResolvedValue([]),
                getCloneParams: jest.fn().mockResolvedValue(null),
            } as any,
        );
        return { stage, reviewOrchestrator };
    };

    const sugg = (over: Record<string, unknown> = {}) => ({
        relevantFile: 'src/user.ts',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'user object can be null and is dereferenced',
        suggestionContent: 'user object can be null and is dereferenced here',
        improvedCode: 'if (!user) return;',
        ...over,
    });

    const makeContext = () =>
        frozenContext({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            repository: { id: 'repo-1', name: 'repo-1' },
            pullRequest: { number: 7 },
            platformType: 'GITHUB',
            // No patch ⇒ extractValidDiffLines=[] ⇒ snapLinesToDiff passes the
            // suggestion through untouched, so assembly keeps it verbatim.
            changedFiles: [{ filename: 'src/user.ts' }],
            codeReviewConfig: {
                reviewOptions: {},
                heavy: false,
                resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            },
            heavy: false,
            validSuggestions: [],
            discardedSuggestions: [],
            errors: [],
        }) as any as CodeReviewPipelineContext;

    const orchestratorResult = () => ({
        suggestions: [sugg(), sugg()],
        agentResults: [],
        failures: [],
        incomplete: [],
        warnings: [],
    });

    let runSpy: jest.SpyInstance;
    afterEach(() => {
        runSpy?.mockRestore();
        jest.clearAllMocks();
    });

    it('assembles deduped findings when the envelope is correct', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
        } as any);
        const { stage } = makeStage(orchestratorResult());

        const result: any = await (stage as any).executeStage(makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.dedupTrace.status).toBe('success');
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(result.fileAnalysisResults[0].file.filename).toBe('src/user.ts');
    });

    it('keeps all findings and does not throw past the stage when dedup rejects', async () => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockRejectedValue(new Error('dedup provider down'));
        const { stage } = makeStage(orchestratorResult());

        const result: any = await (stage as any).executeStage(makeContext());

        // Stage boundary absorbs the dedup failure: both findings survive,
        // trace records WHY, and the stage returns its declared context.
        expect(result.validSuggestions).toHaveLength(2);
        expect(result.dedupTrace.status).toBe('failed-keep-all');
        expect(Array.isArray(result.fileAnalysisResults)).toBe(true);
    });

    it('returns the context unchanged when there are no changed files (guard)', async () => {
        const { stage, reviewOrchestrator } = makeStage(orchestratorResult());
        const ctx = { changedFiles: [] } as any;

        const result = await (stage as any).executeStage(ctx);

        expect(result).toBe(ctx);
        expect(reviewOrchestrator.execute).not.toHaveBeenCalled();
    });
});

/**
 * BACKFILL — full LLM.run I/O contract matrix for the dedup boundary (#1786).
 *
 * The rows already pinned by the two describes above (exact D, {result:D}, bare
 * array, stringified, wrong-keys, null, empty-object, out-of-range, throw,
 * single-item, partial-unique-omitted) are NOT re-covered here. This block adds
 * every remaining APPLICABLE row of llm-io-contract-matrix.md so
 * rowsCovered ∪ rowsNA == 42.
 *
 * Boundary shape recap:
 *   D = { groups: [{keep, duplicates[]}], unique: number[] }.
 *   The code reads `dedupOutput?.groups || []` and `dedupOutput?.unique || []`
 *   (agent-review.stage.ts:1902-1903). Any envelope that is not an object with
 *   those two keys collapses to `[]/[]` → the `empty-keep-all` branch
 *   (agent-review.stage.ts:1917) → every suggestion is KEPT. That never drops
 *   data, but when the off-schema payload actually CARRIED a duplicate group the
 *   dedup silently becomes a no-op and the duplicate ships. Those rows are pinned
 *   with `it.failing` against the CORRECT (recovering) behavior: green today,
 *   red the day #1786 teaches the reader to unwrap/parse/alias.
 */
describe('AgentReviewStage — dedup LLM.run contract matrix backfill (#1786)', () => {
    const makeStage = () =>
        new AgentReviewStage(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

    const slot = { provider: 'openai', model: 'gpt-4o-mini' } as any;
    const telemetryMeta = {
        organizationId: 'org-1',
        teamId: 'team-1',
        pullRequestId: 7,
        repositoryId: 'repo-1',
    } as any;

    // Identical text ⇒ contentSimilarity=1 ⇒ the content guard honors a model
    // merge lexically, so an honored merge needs NO embedding/tiebreak model
    // call — the dedup outcome is fully deterministic in the unit.
    const dupA = () => ({
        relevantFile: 'src/user.ts',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'user object can be null and is dereferenced',
        suggestionContent: 'user object can be null and is dereferenced here',
        improvedCode: 'if (!user) return;',
    });
    const dupB = () => ({ ...dupA() });
    const distinctX = () => ({
        relevantFile: 'src/a.ts',
        relevantLinesStart: 1,
        relevantLinesEnd: 2,
        label: 'bug',
        severity: 'high',
        oneSentenceSummary: 'off by one error in the pagination loop',
        suggestionContent: 'the pagination loop iterates one element too far',
        improvedCode: 'for (let i = 0; i < n; i++)',
    });
    const distinctY = () => ({
        relevantFile: 'src/b.ts',
        relevantLinesStart: 40,
        relevantLinesEnd: 41,
        label: 'security',
        severity: 'critical',
        oneSentenceSummary: 'sql query built via string concatenation',
        suggestionContent: 'concatenating user input into the sql string',
        improvedCode: 'db.query(sql, [param])',
    });

    let runSpy: jest.SpyInstance;
    afterEach(() => {
        runSpy?.mockRestore();
        jest.clearAllMocks();
        (hasManagedModelKey as jest.Mock).mockReturnValue(false);
    });

    const dedup = (
        stage: AgentReviewStage,
        suggestions: any[],
        useSlot: any = slot,
    ) =>
        (stage as any).deduplicateSuggestions(
            suggestions,
            7,
            useSlot,
            telemetryMeta,
        ) as Promise<{ suggestions: any[]; trace: any }>;

    // ── A. Output-shape zoo ────────────────────────────────────────────────

    // A3 — a NON-iterable payload for the array fields (single object where an
    // array is expected). `groups` truthy-but-not-array skips the empty branch,
    // then `for..of` over it throws → the boundary fails LOUD in dev/CI rather
    // than silently degrading. Fail-explicit satisfies the non-degradation rule.
    it('A3: single object where array expected — fails loud, not silent', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: { keep: 0, duplicates: [1] },
            unique: [],
        } as any);
        const stage = makeStage();
        await expect(dedup(stage, [dupA(), dupB()])).rejects.toThrow();
    });

    // A5 — double wrapper {result:{result:D}}. `.groups` undefined ⇒ keep-all;
    // the carried duplicate should still be removed. it.failing until #1786.
    it.failing(
        'A5: double wrapper {result:{result:D}} — should still dedup',
        async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                result: {
                    result: {
                        groups: [{ keep: 0, duplicates: [1] }],
                        unique: [],
                    },
                },
            } as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A6 — opaque single-key wrap {content:D} / {"0":D}.
    it.failing(
        'A6: {content:D} opaque wrapper — should still dedup',
        async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                content: { groups: [{ keep: 0, duplicates: [1] }], unique: [] },
            } as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );
    it.failing(
        'A6: {"0":D} numeric-key wrapper — should still dedup',
        async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                '0': { groups: [{ keep: 0, duplicates: [1] }], unique: [] },
            } as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A8 — markdown-fenced JSON string.
    it.failing(
        'A8: markdown-fenced ```json block — should still dedup',
        async () => {
            const fenced =
                '```json\n' +
                JSON.stringify({
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [],
                }) +
                '\n```';
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue(fenced as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A9 — prose-wrapped JSON string.
    it.failing(
        'A9: prose-wrapped "Here is the result: {…}" — should still dedup',
        async () => {
            const prose =
                'Here is the result: ' +
                JSON.stringify({
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [],
                }) +
                '\n\nLet me know if you need anything else.';
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue(prose as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A11 — case/convention mismatch on the keys.
    it.failing(
        'A11: capitalized {Groups,Unique} keys — should still dedup',
        async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                Groups: [{ keep: 0, duplicates: [1] }],
                Unique: [],
            } as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A13 — extra unknown keys alongside the right ones: MUST tolerate and dedup.
    it('A13: extra unknown keys are tolerated (still dedups)', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
            reasoning: 'these two describe the same null deref',
            confidence: 0.9,
        } as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(1);
        expect(out.trace.status).toBe('success');
    });

    // A15 — empty array [] (no dedup info) ⇒ keep all, explicit empty-keep-all.
    it('A15: empty array [] — keep all, empty-keep-all (no drop, no throw)', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue([] as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // A16 — empty / whitespace-only string ⇒ keep all, explicit empty-keep-all.
    it.each([
        ['empty string', ''],
        ['whitespace only', '   \n\t  '],
    ])('A16: %s — keep all, empty-keep-all', async (_l, payload) => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue(payload as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // A18 — primitive where an object is expected.
    it.each([
        ['boolean true', true],
        ['number 0', 0],
        ['string "ok"', 'ok'],
    ])('A18: primitive %s — keep all, no throw', async (_l, payload) => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue(payload as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // A19 — provider envelope leak: the raw {choices:[{message:{content}}]}
    // envelope reaches the boundary with the real D as a stringified
    // tool/message content. `.groups` undefined ⇒ keep-all no-op today.
    it.failing(
        'A19: provider envelope leak {choices:[{message:{content}}]} — should still dedup',
        async () => {
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                groups: [{ keep: 0, duplicates: [1] }],
                                unique: [],
                            }),
                        },
                    },
                ],
            } as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // A20 — reasoning/thinking leak: analysis prose prefixed before the JSON.
    it.failing(
        'A20: reasoning/thinking leak before the JSON — should still dedup',
        async () => {
            const leaked =
                'Let me think. [0] and [1] are the same null deref, so I will group them.\n' +
                JSON.stringify({
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [],
                });
            runSpy = jest.spyOn(LLM, 'run').mockResolvedValue(leaked as any);
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(1);
        },
    );

    // ── B. Semantic-but-wrong (routed to the sibling tiebreak LLM.run) ──────
    // DEDUP_SCHEMA's own D carries only numeric arrays (no boolean/enum/string
    // value fields), so the boolean-encoding rows are exercised against the
    // OTHER LLM.run boundary in this file: buildDedupTiebreak, whose D is
    // {rootCauseA,rootCauseB,sameBug:boolean}. Its documented contract is
    // "anything that is not a real boolean ⇒ null ⇒ the caller vetoes (keeps
    // both)" — an OBSERVABLE, logged safe-default (never a silent drop).
    describe('B: tiebreak sameBug value-encoding contract', () => {
        const buildTb = (stage: AgentReviewStage) =>
            (stage as any).buildDedupTiebreak(slot, telemetryMeta, 7) as (
                a: any,
                b: any,
            ) => Promise<boolean | null>;

        it('B(happy): clean boolean is trusted (true/false pass through)', async () => {
            const stage = makeStage();
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValueOnce({ sameBug: true } as any)
                .mockResolvedValueOnce({ sameBug: false } as any);
            const tb = buildTb(stage);
            expect(await tb(dupA(), dupB())).toBe(true);
            expect(await tb(distinctX(), distinctY())).toBe(false);
        });

        it('B21: boolean as string "true" — vetoes to null (observable safe-default)', async () => {
            const stage = makeStage();
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ sameBug: 'true' } as any);
            expect(await buildTb(stage)(dupA(), dupB())).toBeNull();
        });

        it('B22: boolean as "yes" — vetoes to null', async () => {
            const stage = makeStage();
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ sameBug: 'yes' } as any);
            expect(await buildTb(stage)(dupA(), dupB())).toBeNull();
        });

        it('B23: boolean as number 1 — vetoes to null', async () => {
            const stage = makeStage();
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ sameBug: 1 } as any);
            expect(await buildTb(stage)(dupA(), dupB())).toBeNull();
        });

        it('B(transport): tiebreak LLM.run throws — vetoes to null, never propagates', async () => {
            const stage = makeStage();
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockRejectedValue(new Error('tiebreak boom'));
            expect(await buildTb(stage)(dupA(), dupB())).toBeNull();
        });
    });

    // B25 — index out of range: covered by the sibling describe; a second angle
    // here — a dangling `keep` beyond input length must never drop the real
    // finding (Layer-3 safety net re-adds it).
    it('B25: dangling keep index beyond input — no finding dropped', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 7, duplicates: [0] }],
            unique: [],
        } as any);
        const stage = makeStage();
        const out = await dedup(stage, [distinctX(), distinctY()]);
        expect(out.suggestions).toHaveLength(2);
    });

    // ── C. Unparseable / transport / fail-safe ─────────────────────────────

    // C28 — truncated JSON: LLM.run resolves a partial group (duplicates lost to
    // max_tokens). `duplicates || []` ⇒ no merge; Layer-3 re-adds the un-
    // classified index. Net: keep all — no silent drop from a truncated payload.
    it('C28: truncated group (duplicates missing) — no finding dropped', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0 }],
            unique: [],
        } as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
    });

    // C29 — malformed JSON surfaces as an LLM.run rejection. In production the
    // documented fallback is failed-keep-all with the reason recorded.
    it('C29: malformed JSON (LLM.run rejects) — production failed-keep-all with reason', async () => {
        const prev = process.env.API_NODE_ENV;
        process.env.API_NODE_ENV = 'production';
        try {
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockRejectedValue(
                    new SyntaxError('Unexpected token } in JSON at position 42'),
                );
            const stage = makeStage();
            const out = await dedup(stage, [dupA(), dupB()]);
            expect(out.suggestions).toHaveLength(2);
            expect(out.trace.status).toBe('failed-keep-all');
            expect(out.trace.errorMessage).toContain('Unexpected token');
        } finally {
            process.env.API_NODE_ENV = prev;
        }
    });

    // C31 — error object returned instead of throwing: no dedup info ⇒ keep all,
    // explicit empty-keep-all, never a throw past the boundary.
    it('C31: {error:…} object — keep all, empty-keep-all, no throw', async () => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ error: 'quota_exceeded' } as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // C32 — empty success (content:'' / finish_reason:'length').
    it('C32: empty success content — keep all, empty-keep-all', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue('' as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // C33 — refusal prose.
    it('C33: refusal prose ("I cannot help…") — keep all, no throw', async () => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue(
                "I'm sorry, but I can't help with that request." as any,
            );
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(2);
        expect(out.trace.status).toBe('empty-keep-all');
    });

    // C34 — abort signal fired mid-call surfaces as an AbortError rejection;
    // dev/CI fails loud (re-throw) rather than shipping an unverified no-op.
    it('C34: abort mid-call — fails loud in dev/CI (re-throws)', async () => {
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        runSpy = jest.spyOn(LLM, 'run').mockRejectedValue(abort);
        const stage = makeStage();
        await expect(dedup(stage, [dupA(), dupB()])).rejects.toThrow(
            'aborted',
        );
    });

    // ── D. Input variants ──────────────────────────────────────────────────

    // D35 — empty input: short-circuits to skipped, no model call.
    it('D35: empty input — skipped, no LLM call', async () => {
        runSpy = jest.spyOn(LLM, 'run');
        const stage = makeStage();
        const out = await dedup(stage, []);
        expect(out.suggestions).toHaveLength(0);
        expect(out.trace.status).toBe('skipped');
        expect(runSpy).not.toHaveBeenCalled();
    });

    // D37 — large input: the dedup pass sends ALL suggestions in ONE prompt (no
    // token/batch chunking), so a large list is still a single LLM.run call and
    // every finding is preserved when the model marks them all unique.
    it('D37: large input (no batching) — single call, all preserved', async () => {
        const many = Array.from({ length: 50 }, (_, i) => ({
            relevantFile: `src/f${i}.ts`,
            relevantLinesStart: i + 1,
            relevantLinesEnd: i + 2,
            label: 'bug',
            severity: 'medium',
            oneSentenceSummary: `finding number ${i} about a distinct issue`,
            suggestionContent: `distinct issue ${i} body text unique tokens ${i}`,
            improvedCode: `fix_${i}()`,
        }));
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [],
            unique: many.map((_, i) => i),
        } as any);
        const stage = makeStage();
        const out = await dedup(stage, many);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(out.suggestions).toHaveLength(50);
    });

    // D38 — duplicate items in input: the model groups them, one survives.
    it('D38: duplicate items in input — collapsed to one', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
        } as any);
        const stage = makeStage();
        const out = await dedup(stage, [dupA(), dupB()]);
        expect(out.suggestions).toHaveLength(1);
        expect(out.trace.removedCount).toBe(1);
    });

    // D39 — input item with null/undefined required fields: prompt/summary
    // building tolerates it; nothing crashes and nothing is dropped.
    it('D39: null/undefined required fields — no throw, nothing dropped', async () => {
        const a = {
            relevantFile: null,
            relevantLinesStart: null,
            relevantLinesEnd: undefined,
            label: undefined,
            severity: undefined,
            oneSentenceSummary: undefined,
            suggestionContent: undefined,
        };
        const b = { ...distinctY() };
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ groups: [], unique: [0, 1] } as any);
        const stage = makeStage();
        const out = await dedup(stage, [a, b]);
        expect(out.suggestions).toHaveLength(2);
    });

    // D40 — special chars / unicode / emoji / whitespace in text fields.
    it('D40: unicode / emoji / whitespace content — no throw, preserved', async () => {
        const a = {
            ...distinctX(),
            oneSentenceSummary: '空指针 💥 dereference — off\tby\none',
            suggestionContent: '  \n user → null 🚨   weird \\n escaped ',
        };
        const b = { ...distinctY(), oneSentenceSummary: '🔒 sql 注入 injection' };
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ groups: [], unique: [0, 1] } as any);
        const stage = makeStage();
        const out = await dedup(stage, [a, b]);
        expect(out.suggestions).toHaveLength(2);
    });

    // D42 — order permutation ⇒ equivalent decision. The same duplicate pair,
    // fed [A,B] or [B,A] (with the model grouping keep:0/dup:[1] each time),
    // collapses to a single survivor either way.
    it('D42: order permutation — equivalent survivor count', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue({
            groups: [{ keep: 0, duplicates: [1] }],
            unique: [],
        } as any);
        const stage = makeStage();
        const forward = await dedup(stage, [dupA(), dupB()]);
        const reversed = await dedup(stage, [dupB(), dupA()]);
        expect(forward.suggestions).toHaveLength(1);
        expect(reversed.suggestions).toHaveLength(1);
    });

    // ── E. Provider / model matrix (gate delegation) ───────────────────────
    // The boundary does NOT branch on model — it threads `byokConfig` to LLM.run
    // and LLM.run owns the json_schema→json_object policy (structured-output-
    // gate.ts). So the boundary behaves identically across the N providers, and
    // the correct place to prove the branch is the request it hands the gate.
    describe('E: model-agnostic delegation to the structured-output gate', () => {
        it.each([
            ['openai (strict json_schema)', 'openai'],
            ['anthropic (strict)', 'anthropic'],
            ['google (strict)', 'google'],
            ['moonshotai (strict)', 'moonshotai'],
            ['kimi (json_object fallback)', 'kimi'],
            ['glm (fallback)', 'glm'],
            ['deepseek (fallback)', 'deepseek'],
            ['z-ai (fallback)', 'z-ai'],
        ])(
            'threads the %s slot verbatim to LLM.run (byok attribution)',
            async (_label, provider) => {
                const useSlot = { provider, model: `${provider}/m` } as any;
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue({ groups: [], unique: [0, 1] } as any);
                const stage = makeStage();
                await dedup(stage, [distinctX(), distinctY()], useSlot);
                const req = runSpy.mock.calls[0][0];
                expect(req.byokConfig).toBe(useSlot);
                expect(req.schema).toBeTruthy();
                expect(req.attrs).toEqual(
                    expect.objectContaining({ type: 'byok', prNumber: 7 }),
                );
            },
        );

        it('no slot but a managed key is configured — system attribution, call still made', async () => {
            (hasManagedModelKey as jest.Mock).mockReturnValue(true);
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ groups: [], unique: [0, 1] } as any);
            const stage = makeStage();
            const out = await (stage as any).deduplicateSuggestions(
                [distinctX(), distinctY()],
                7,
                undefined,
                telemetryMeta,
            );
            expect(runSpy).toHaveBeenCalledTimes(1);
            const req = runSpy.mock.calls[0][0];
            expect(req.byokConfig).toBeUndefined();
            expect(req.attrs.type).toBe('system');
            expect(out.trace.status).toBe('success');
        });

        it('no slot AND no managed key — skipped, no call (fail-closed, keep all)', async () => {
            (hasManagedModelKey as jest.Mock).mockReturnValue(false);
            runSpy = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ groups: [], unique: [0, 1] } as any);
            const stage = makeStage();
            const out = await (stage as any).deduplicateSuggestions(
                [distinctX(), distinctY()],
                7,
                undefined,
                telemetryMeta,
            );
            expect(runSpy).not.toHaveBeenCalled();
            expect(out.suggestions).toHaveLength(2);
            expect(out.trace.status).toBe('skipped');
        });

        // The #1786 off-schema class is model-INDEPENDENT: a bare array carrying
        // a real duplicate degrades to a no-op under BOTH a strict and a
        // fallback slot today. Pinned it.failing under each branch so the fix is
        // proven to land for every provider, not just the strict ones.
        it.failing(
            'E: bare-array off-schema under a STRICT slot — should still dedup',
            async () => {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue([
                        { keep: 0, duplicates: [1] },
                    ] as any);
                const stage = makeStage();
                const out = await dedup(stage, [dupA(), dupB()], {
                    provider: 'openai',
                    model: 'gpt-4o-mini',
                } as any);
                expect(out.suggestions).toHaveLength(1);
            },
        );
        it.failing(
            'E: bare-array off-schema under a FALLBACK slot — should still dedup',
            async () => {
                runSpy = jest
                    .spyOn(LLM, 'run')
                    .mockResolvedValue([
                        { keep: 0, duplicates: [1] },
                    ] as any);
                const stage = makeStage();
                const out = await dedup(stage, [dupA(), dupB()], {
                    provider: 'moonshotai',
                    model: 'kimi-k2',
                } as any);
                expect(out.suggestions).toHaveLength(1);
            },
        );
    });
});
