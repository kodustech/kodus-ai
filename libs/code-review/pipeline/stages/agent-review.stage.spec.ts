import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

// The stage's post-orchestrator helpers (severity reclassification + content
// formatter) each make their OWN model calls. They are irrelevant to the
// orchestrator-envelope boundary under test here, so stub them to no-ops.
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
// Keep every real export of managed-slot; only make hasManagedModelKey
// deterministic so the dedup "no secondary model" branch does not depend on
// which provider env keys happen to be set in the test host.
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * CONTRACT tests for the MAIN agent-review boundary in
 * AgentReviewStage.executeStage: the model-output envelope returned by
 * `reviewOrchestrator.execute()` (issue #1786 / #1568).
 *
 * The two literal `LLM.run` sites in this file both belong to the dedup pass and
 * are pinned in agent-review.stage.dedup-contract.spec.ts. This suite covers the
 * OTHER boundary the stage parses: the finder's review result. From the stage's
 * point of view the orchestrator IS the LLM boundary — it wraps the finder's
 * per-agent model calls and hands back a single envelope
 *
 *     D = { suggestions: CodeSuggestion[],
 *           agentResults?, failures?, incomplete?, warnings? }
 *
 * The stage reads `result.suggestions` with `.length` (agent-review.stage.ts:686)
 * and `.map` (agent-review.stage.ts:901). Any envelope where `suggestions` is not
 * an array makes that access throw; the throw is caught by the stage's outer
 * try/catch (agent-review.stage.ts:1421) which — per the #1568 fix — records a
 * CRITICAL error, sets `lastReviewError`, empties `fileAnalysisResults`, and
 * RETURNS the context (never re-throws, never reports a silent "found nothing"
 * success that would auto-approve the PR). That is the non-degradation contract
 * for this boundary: an off-schema envelope FAILS EXPLICITLY, it does not
 * silently drop findings.
 *
 * SCOPE = the deterministic layer only: envelope parsing, the guaranteed return
 * shape, and fail-safe. The model's finding QUALITY is the eval track, not here.
 */

// ── Shared harness ─────────────────────────────────────────────────────────
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

const happyEnvelope = (suggestions: any[] = [sugg()]) => ({
    suggestions,
    agentResults: [],
    failures: [],
    incomplete: [],
    warnings: [],
});

const makeStage = () => {
    const reviewOrchestrator = { execute: jest.fn() };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any, // automationExecutionService
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any, // repositoryService
        reviewOrchestrator as any, // reviewOrchestrator (the boundary under test)
        {
            runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()),
        } as any, // observabilityService
        {
            generateContext: jest.fn(),
            generateContextLegacy: jest.fn(),
        } as any, // graphContext
        { isEnabled: jest.fn().mockResolvedValue(false) } as any, // featureGate
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any, // organizationService
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any, // codeManagementService
    );
    return { stage, reviewOrchestrator };
};

const makeContext = (over: Record<string, unknown> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        // No patch ⇒ extractValidDiffLines=[] ⇒ snapLinesToDiff passes the
        // suggestion through untouched, so assembly keeps it verbatim on the
        // file that matches `relevantFile`.
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
        ...over,
    }) as any as CodeReviewPipelineContext;

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

const criticalErrors = (result: any) =>
    (result.errors ?? []).filter((e: any) => e.severity === 'critical');

/**
 * The #1568 explicit-failure contract for an off-schema orchestrator envelope:
 * the stage caught the parse throw, recorded a critical error + lastReviewError,
 * emptied fileAnalysisResults, and returned the context WITHOUT re-throwing and
 * WITHOUT a silent zero-findings success.
 */
const expectExplicitFailure = (result: any) => {
    expect(result).toBeTruthy();
    expect(result.fileAnalysisResults).toEqual([]);
    expect(criticalErrors(result).length).toBeGreaterThanOrEqual(1);
    expect(criticalErrors(result)[0].stage).toBe('AgentReviewStage');
    expect(result.lastReviewError).toBeTruthy();
};

let runSpy: jest.SpyInstance;
beforeEach(() => {
    // Dedup's LLM.run: default keep-all so a >1-suggestion envelope assembles
    // deterministically. Off-schema tests throw before dedup ever runs.
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [0, 1, 2, 3] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
});

// ════════════════════════════════════════════════════════════════════════════
// A. Output-shape zoo — the orchestrator envelope is NOT the declared D
// ════════════════════════════════════════════════════════════════════════════
describe('A. orchestrator output-shape zoo', () => {
    // A1 — exact D, happy path: the finder's findings assemble into
    // validSuggestions + one fileAnalysisResults entry per changed file.
    it('A1: exact D envelope — assembles findings, no error', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(result.fileAnalysisResults[0].file.filename).toBe('src/user.ts');
        expect(criticalErrors(result)).toHaveLength(0);
    });

    // A2 — bare array of findings instead of `{suggestions}`. `.suggestions`
    // undefined ⇒ `.length` throws ⇒ #1568 explicit failure (the real payload is
    // NOT recovered, but it is NOT silently shipped as success either).
    it('A2: bare array of findings — fails explicitly, not silent', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue([sugg()] as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A3 — single object where an array is expected (suggestions is an object).
    // `.length` reads undefined (no throw), then `.map` throws ⇒ explicit fail.
    it('A3: {suggestions:{obj}} single object — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            suggestions: sugg(),
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A4 — wrapper keys carrying the real D. Not recovered ⇒ explicit fail.
    it.each([
        ['{result:D}', (d: any) => ({ result: d })],
        ['{data:D}', (d: any) => ({ data: d })],
        ['{output:D}', (d: any) => ({ output: d })],
        ['{response:D}', (d: any) => ({ response: d })],
    ])('A4: %s wrapper — fails explicitly', async (_l, wrap) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            wrap(happyEnvelope([sugg()])) as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A5 — double wrapper {result:{result:D}}.
    it('A5: double wrapper {result:{result:D}} — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            result: { result: happyEnvelope([sugg()]) },
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A6 — opaque / numeric single-key wrapper.
    it.each([
        ['{content:D}', (d: any) => ({ content: d })],
        ['{"0":D}', (d: any) => ({ '0': d })],
    ])('A6: %s wrapper — fails explicitly', async (_l, wrap) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            wrap(happyEnvelope([sugg()])) as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A7 — the whole D as a JSON string.
    it('A7: stringified JSON envelope — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            JSON.stringify(happyEnvelope([sugg()])) as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A8 — markdown-fenced JSON string.
    it('A8: markdown-fenced ```json block — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            ('```json\n' + JSON.stringify(happyEnvelope([sugg()])) + '\n```') as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A9 — prose-wrapped JSON string.
    it('A9: prose-wrapped "Here is the result: {…}" — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            ('Here is the result: ' +
                JSON.stringify(happyEnvelope([sugg()])) +
                '\n\nLet me know if you need anything else.') as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A10 — right data under the wrong key name.
    it('A10: right data wrong key {findings:[…]} — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            findings: [sugg()],
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A11 — case/convention mismatch on the key.
    it('A11: {Suggestions:[…]} capitalized key — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            Suggestions: [sugg()],
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A12 — partial object: only `suggestions`, every optional key omitted. The
    // stage tolerates missing agentResults/failures/incomplete/warnings via
    // `?? []` / `|| []` and assembles normally.
    it('A12: partial object (only suggestions) — tolerated, assembles', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            suggestions: [sugg()],
        } as any);

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(criticalErrors(result)).toHaveLength(0);
    });

    // A13 — extra unknown keys alongside the right ones: tolerated, not crashed.
    it('A13: extra unknown keys tolerated — still assembles', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            ...happyEnvelope([sugg()]),
            reasoning: 'analysis prose',
            confidence: 0.9,
            usage: { tokens: 1234 },
        } as any);

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(criticalErrors(result)).toHaveLength(0);
    });

    // A14 — empty object {} (no suggestions key).
    it('A14: empty object {} — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({} as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A15 — bare empty array [] (not {suggestions:[]}). `.suggestions`
    // undefined ⇒ `.length` throws ⇒ explicit failure. Distinct from C32.
    it('A15: bare empty array [] — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue([] as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A16 — empty / whitespace-only string.
    it.each([
        ['empty string', ''],
        ['whitespace only', '   \n\t  '],
    ])('A16: %s envelope — fails explicitly', async (_l, payload) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(payload as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A17 — null / undefined envelope.
    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('A17: %s envelope — fails explicitly', async (_l, payload) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(payload as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A18 — primitive where an object is expected.
    it.each([
        ['boolean true', true],
        ['number 0', 0],
        ['string "ok"', 'ok'],
    ])('A18: primitive %s — fails explicitly', async (_l, payload) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(payload as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A19 — provider envelope leak: the raw {choices:[{message:{content}}]}
    // shape reaches the boundary. `.suggestions` undefined ⇒ explicit fail.
    it('A19: provider envelope leak {choices:[…]} — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify(happyEnvelope([sugg()])),
                    },
                },
            ],
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // A20 — reasoning/thinking leak: analysis prose prefixed before the JSON.
    it('A20: reasoning/thinking leak before JSON — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            ('Let me think about whether this null deref matters...\n' +
                JSON.stringify(happyEnvelope([sugg()]))) as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Semantic-but-wrong (valid envelope, wrong value encoding on the findings)
// ════════════════════════════════════════════════════════════════════════════
describe('B. semantic-but-wrong finding values', () => {
    // B24 — severity out of the allowed set. normalizeSeverity coerces any
    // unknown value to the documented MEDIUM default — the finding is NEVER
    // dropped, and the default is observable on the shipped suggestion.
    it('B24: out-of-set severity "URGENT" — coerced to medium, not dropped', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ severity: 'URGENT' })]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.validSuggestions[0].severity).toBe('medium');
        expect(criticalErrors(result)).toHaveLength(0);
    });

    // B25 — dangling line reference: the finding cites lines that do not overlap
    // any changed hunk. It is dropped by snapLinesToDiff, but SIGNALLED — routed
    // to discardedSuggestions as DISCARDED_BY_CODE_DIFF, never silently vanished.
    it('B25: out-of-diff line reference — signalled as discarded, not silent', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ relevantLinesStart: 500, relevantLinesEnd: 505 })]),
        );
        // A real patch so extractValidDiffLines yields a range that lines 500-505
        // fall outside of.
        const ctx = makeContext({
            changedFiles: [
                {
                    filename: 'src/user.ts',
                    patch: '@@ -1,3 +1,4 @@\n line1\n+line2\n line3\n line4',
                },
            ],
        });

        const result = await run(stage, ctx);

        expect(result.validSuggestions).toHaveLength(0);
        const discarded = result.discardedSuggestions ?? [];
        expect(discarded.length).toBeGreaterThanOrEqual(1);
        expect(discarded.some((d: any) => d.relevantFile === 'src/user.ts')).toBe(
            true,
        );
    });

    // B27 — unicode / emoji / escaped newlines inside string fields survive the
    // deterministic pipeline unchanged.
    it('B27: unicode / emoji / escaped-newline content — preserved verbatim', async () => {
        const weird = '空指针 💥 dereference — line1\\nline2 🚨';
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ suggestionContent: weird })]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.validSuggestions[0].suggestionContent).toBe(weird);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Unparseable / transport / fail-safe
// ════════════════════════════════════════════════════════════════════════════
describe('C. transport / fail-safe', () => {
    // C28 — truncated envelope: a finding missing its relevantFile (dropped to
    // max_tokens). It cannot anchor to a changed file, so it is TRACKED in
    // discardedSuggestions (DISCARDED_BY_CODE_DIFF) with a warn — the silent-drop
    // guard (agent-review.stage.ts:1382-1388). It still survives on
    // validSuggestions so it reaches Mongo and can be reconciled — never silent.
    it('C28: truncated finding (no relevantFile) — tracked, not silently lost', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                { oneSentenceSummary: 'partial finding', suggestionContent: 'x' },
            ]),
        );

        const result = await run(stage, makeContext());

        // Preserved on validSuggestions AND recorded in discardedSuggestions —
        // the finding is observable in both places, not vanished.
        expect(result.validSuggestions).toHaveLength(1);
        expect((result.discardedSuggestions ?? []).length).toBeGreaterThanOrEqual(
            1,
        );
        // Never throws past the boundary.
        expect(result.fileAnalysisResults).toBeDefined();
    });

    // C29 — malformed JSON surfaces as an orchestrator rejection (the parse blew
    // up inside the finder). Caught ⇒ explicit failure, never propagates.
    it('C29: malformed JSON (orchestrator rejects) — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockRejectedValue(
            new SyntaxError('Unexpected token } in JSON at position 42'),
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // C30 — the orchestrator throws (network / timeout / provider 500). THE core
    // #1568 fail-safe: the stage records a critical error and returns, it does
    // NOT re-throw and does NOT report a silent zero-findings success.
    it('C30: orchestrator throws — caught, critical error, never re-thrown', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockRejectedValue(
            new Error('provider 500 / connection reset'),
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
        expect(result.lastReviewError.occurredAt).toBeInstanceOf(Date);
    });

    // C31 — error object returned instead of thrown. `.suggestions` undefined ⇒
    // explicit failure (the parse throw path), never a silent no-op.
    it('C31: {error:…} object returned — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            error: 'quota_exceeded',
        } as any);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // C32 — empty success: {suggestions:[]} with the key PRESENT. This is a
    // legitimate "found nothing" — assemble zero findings, NO critical error.
    it('C32: {suggestions:[]} empty success — zero findings, no error', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([]));

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(0);
        expect(result.fileAnalysisResults).toEqual([]);
        expect(criticalErrors(result)).toHaveLength(0);
        expect(result.lastReviewError).toBeFalsy();
    });

    // C33 — refusal prose returned as the whole envelope.
    it('C33: refusal prose ("I cannot help…") — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            "I'm sorry, but I can't help with that request." as any,
        );

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // C34 — abort signal fired mid-review surfaces as an AbortError rejection;
    // caught, never propagated past the stage.
    it('C34: abort mid-review (AbortError) — caught, never propagates', async () => {
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockRejectedValue(abort);

        const result = await run(stage, makeContext());

        expectExplicitFailure(result);
    });

    // Per-agent failures reported IN a valid envelope (not a throw): a critical
    // agent failure is recorded as a critical error while the surviving findings
    // still assemble — the review is degraded, not lost.
    it('records a critical error for a failed core agent inside a valid envelope', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue({
            ...happyEnvelope([sugg()]),
            failures: [
                {
                    agentName: 'security',
                    category: 'security',
                    error: new Error('security agent crashed'),
                },
            ],
        });

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1); // surviving finding kept
        expect(
            criticalErrors(result).some(
                (e: any) => e.substage === 'agent:security',
            ),
        ).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Input variants (fed into executeStage with a happy orchestrator envelope)
// ════════════════════════════════════════════════════════════════════════════
describe('D. input variants', () => {
    // D35 — empty input: the stage's guard returns the context unchanged and the
    // orchestrator is never invoked.
    it('D35: empty changedFiles — returns context untouched, no orchestrator call', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        const ctx = makeContext({ changedFiles: [] });

        const result = await run(stage, ctx);

        expect(result).toBe(ctx);
        expect(reviewOrchestrator.execute).not.toHaveBeenCalled();
    });

    // D36 — single file / single finding assembles into exactly one file entry.
    it('D36: single file + single finding — one fileAnalysisResults entry', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));

        const result = await run(stage, makeContext());

        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(result.validSuggestions).toHaveLength(1);
    });

    // D37 — large input: the stage does NOT batch (batching is the orchestrator's
    // concern). Every finding across many files must still land in the assembled
    // result — nothing dropped for volume.
    it('D37: large multi-file input — every finding preserved, single orchestrator call', async () => {
        const files = Array.from({ length: 40 }, (_, i) => ({
            filename: `src/f${i}.ts`,
        }));
        const findings = files.map((f, i) =>
            sugg({
                relevantFile: f.filename,
                oneSentenceSummary: `finding ${i}`,
                suggestionContent: `distinct issue ${i}`,
            }),
        );
        runSpy.mockResolvedValue({
            groups: [],
            unique: findings.map((_, i) => i),
        } as any);
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope(findings));

        const result = await run(stage, makeContext({ changedFiles: files }));

        expect(reviewOrchestrator.execute).toHaveBeenCalledTimes(1);
        expect(result.validSuggestions).toHaveLength(40);
        expect(result.fileAnalysisResults).toHaveLength(40);
    });

    // D38 — duplicate findings in the envelope (dedup mocked keep-all here) both
    // reach assembly on the same file — no crash on collision.
    it('D38: duplicate findings on the same file — assemble without crashing', async () => {
        runSpy.mockResolvedValue({ groups: [], unique: [0, 1] } as any);
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg(), sugg()]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(2);
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(result.fileAnalysisResults[0].validSuggestionsToAnalyze).toHaveLength(
            2,
        );
    });

    // D39 — a finding with null/undefined required fields: no throw; it cannot
    // anchor, so it is tracked in discardedSuggestions (never silently lost) and
    // still preserved on validSuggestions.
    it('D39: finding with null relevantFile — no throw, tracked not lost', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    relevantFile: null,
                    relevantLinesStart: null,
                    relevantLinesEnd: undefined,
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.fileAnalysisResults).toBeDefined();
        expect((result.discardedSuggestions ?? []).length).toBeGreaterThanOrEqual(
            1,
        );
    });

    // D40 — special chars / whitespace-only diff + binary-ish patch: no throw,
    // the finding still assembles.
    it('D40: whitespace-only / binary-ish patch — no throw, finding assembles', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));
        const ctx = makeContext({
            changedFiles: [
                { filename: 'src/user.ts', patch: '   \n\t\n  binary' },
            ],
        });

        const result = await run(stage, ctx);

        // No valid diff ranges parsed ⇒ snap passes through ⇒ finding assembles.
        expect(result.validSuggestions).toHaveLength(1);
        expect(result.fileAnalysisResults).toHaveLength(1);
    });

    // D42 — order permutation: the SAME two findings fed in either order produce
    // the same assembled set (metamorphic — set equality, not list order).
    it('D42: order permutation — equivalent assembled set', async () => {
        runSpy.mockResolvedValue({ groups: [], unique: [0, 1] } as any);
        const a = sugg({ relevantFile: 'src/a.ts', oneSentenceSummary: 'A' });
        const b = sugg({ relevantFile: 'src/b.ts', oneSentenceSummary: 'B' });
        const files = [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }];

        const { stage: s1, reviewOrchestrator: o1 } = makeStage();
        o1.execute.mockResolvedValue(happyEnvelope([a, b]));
        const forward = await run(s1, makeContext({ changedFiles: files }));

        const { stage: s2, reviewOrchestrator: o2 } = makeStage();
        o2.execute.mockResolvedValue(happyEnvelope([b, a]));
        const reversed = await run(s2, makeContext({ changedFiles: files }));

        const setOf = (r: any) =>
            (r.validSuggestions ?? [])
                .map((s: any) => s.relevantFile)
                .sort();
        expect(setOf(forward)).toEqual(['src/a.ts', 'src/b.ts']);
        expect(setOf(forward)).toEqual(setOf(reversed));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Provider / model matrix — this boundary delegates model policy
// ════════════════════════════════════════════════════════════════════════════
// The orchestrator boundary does NOT branch on provider: the json_schema vs
// json_object gate (structured-output-gate.ts) lives INSIDE the finder / inside
// LLM.run, not in the stage. The stage threads byok config through
// buildOrchestratorInput and consumes the returned envelope model-agnostically.
// So the correct E assertions here are (1) the off-schema fail-safe is identical
// under a strict and a fallback slot, and (2) the finder's model routing keys are
// threaded verbatim regardless of provider. The A/B/C off-schema rows under each
// concrete gate branch are pinned at the stage's OWN parse layer (its dedup
// LLM.run) in agent-review.stage.dedup-contract.spec.ts.
describe('E. model-agnostic delegation', () => {
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
        'off-schema envelope fails explicitly under the %s slot (model-independent)',
        async (_l, provider) => {
            const { stage, reviewOrchestrator } = makeStage();
            reviewOrchestrator.execute.mockResolvedValue([sugg()] as any); // bare array
            const ctx = makeContext({
                codeReviewConfig: {
                    reviewOptions: {},
                    heavy: false,
                    resolvedModelSlot: { provider, model: `${provider}/m` },
                },
            });

            const result = await run(stage, ctx);

            expectExplicitFailure(result);
        },
    );

    it('threads byokModelId / byokModel verbatim to the orchestrator input', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));
        const ctx = makeContext({
            codeReviewConfig: {
                reviewOptions: {},
                heavy: false,
                resolvedModelSlot: { provider: 'moonshotai', model: 'kimi-k2' },
                byokModelId: 'moonshotai:kimi-k2',
                byokModel: 'kimi-k2-legacy-name',
            },
        });

        await run(stage, ctx);

        expect(reviewOrchestrator.execute).toHaveBeenCalledTimes(1);
        const input = reviewOrchestrator.execute.mock.calls[0][0];
        expect(input.byokModelId).toBe('moonshotai:kimi-k2');
        expect(input.byokModel).toBe('kimi-k2-legacy-name');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Guaranteed return shape — every layer returns the declared context type
// ════════════════════════════════════════════════════════════════════════════
describe('guaranteed return shape across all layers', () => {
    it.each([
        ['happy D', () => happyEnvelope([sugg()]), false],
        ['empty success', () => happyEnvelope([]), false],
        ['bare array (off-schema)', () => [sugg()], true],
        ['null (off-schema)', () => null, true],
        ['primitive (off-schema)', () => 42, true],
    ])(
        'always returns a context with a defined fileAnalysisResults array (%s)',
        async (_l, envelope, isReject) => {
            const { stage, reviewOrchestrator } = makeStage();
            if (isReject && _l.includes('reject')) {
                reviewOrchestrator.execute.mockRejectedValue(new Error('boom'));
            } else {
                reviewOrchestrator.execute.mockResolvedValue(envelope() as any);
            }

            const result = await run(stage, makeContext());

            expect(result).toBeTruthy();
            expect(Array.isArray(result.fileAnalysisResults)).toBe(true);
            expect('validSuggestions' in result).toBe(true);
        },
    );

    it('never re-throws past the stage even when the orchestrator rejects', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockRejectedValue(new Error('hard down'));

        await expect(run(stage, makeContext())).resolves.toBeTruthy();
    });
});
