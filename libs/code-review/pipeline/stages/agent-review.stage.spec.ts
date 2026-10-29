import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
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
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
        },
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

    // A17 — null envelope. Every other off-schema shape (wrappers, strings,
    // primitives, wrong keys) takes the same throw → catch path as A2/A3.
    it('A17: null envelope — fails explicitly', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(null as any);

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
    // Off (#1821): the finder sends no severity and the parse schema drops it;
    // severity is checked before enrichment by its own test.
    it.skip('B24: out-of-set severity "URGENT" — coerced to medium, not dropped', async () => {
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
});

// ════════════════════════════════════════════════════════════════════════════
// C. Unparseable / transport / fail-safe
// ════════════════════════════════════════════════════════════════════════════
describe('C. transport / fail-safe', () => {
    // C28 — truncated envelope: a finder finding missing its relevantFile
    // (dropped to max_tokens). The parse schema (#1821) discards it before the
    // dedup: only a Kody Rule may go without file and lines. Never throws.
    it('C28: truncated finding (no relevantFile) — discarded by the parse schema, no throw', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                { oneSentenceSummary: 'partial finding', suggestionContent: 'x' },
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(0);
        expect(result.fileAnalysisResults).toBeDefined();
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

    // C32 — empty success: {suggestions:[]} with the key PRESENT. This is a
    // legitimate "found nothing" — assemble zero findings, NO critical error.
    it('C32: {suggestions:[]} empty success — zero findings, no error', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([]));

        const result = await run(stage, makeContext());

        expect(result.validSuggestions).toHaveLength(0);
        expect(result.fileAnalysisResults).toEqual([]);
        expect(result.errors ?? []).toHaveLength(0);
        expect(result.lastReviewError).toBeFalsy();
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

    // D39 — a finder finding with null/undefined file and lines: no throw; the
    // parse schema (#1821) discards it before the dedup.
    it('D39: finding with null relevantFile — no throw, discarded by the parse schema', async () => {
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

        expect(result.validSuggestions).toHaveLength(0);
        expect(result.fileAnalysisResults).toBeDefined();
        expect(result.discardedSuggestions).toEqual([
            expect.objectContaining({
                priorityStatus: PriorityStatus.DISCARDED_BY_SCHEMA,
            }),
        ]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Provider / model matrix — this boundary delegates model policy
// ════════════════════════════════════════════════════════════════════════════
// The orchestrator boundary does NOT branch on provider: the json_schema vs
// json_object gate (structured-output-gate.ts) lives INSIDE the finder / inside
// LLM.run, not in the stage. What the stage owns is threading the finder's model
// routing keys verbatim.
describe('E. model-agnostic delegation', () => {
    it('threads byokModelId / byokModel verbatim to the orchestrator input', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));
        const ctx = makeContext({
            codeReviewConfig: {
                reviewOptions: {},
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
