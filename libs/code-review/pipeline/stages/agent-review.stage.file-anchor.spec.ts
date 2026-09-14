import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * #1826 P3 — a finding that does not fit on a line is delivered as a PR comment.
 *
 * `snapLinesToDiff` returns null for a finding whose cited lines overlap no
 * changed hunk, and the caller drops it. That is right for almost everything,
 * and wrong for the one case a rule has declared in advance: a rule that said
 * it needs context beyond the diff is the only thing in the pipeline entitled
 * to point outside it. Derived from spec.md:
 *   KRC-32  a context-needing rule's out-of-hunk finding is marked file-anchored
 *   KRC-19  a file-anchored finding becomes a PR-level comment citing file:line
 *   KRC-20  a file-anchored finding naming a file outside the PR is discarded
 *   KRC-33  a diff-only rule's out-of-hunk finding is still discarded
 */

const CONTEXT_RULE = 'rule-needs-context';
const DIFF_ONLY_RULE = 'rule-diff-only';

// One hunk covering lines 10-12 of the new file. Anything cited outside that
// range overlaps no hunk.
const PATCH = ['@@ -10,2 +10,3 @@', ' const a = 1;', '+const b = 2;'].join(
    '\n',
);

const ruleFinding = (over: Record<string, unknown> = {}) => ({
    relevantFile: 'src/user.ts',
    relevantLinesStart: 120,
    relevantLinesEnd: 180,
    label: 'kody_rules',
    severity: 'high',
    oneSentenceSummary: 'this function is far too long',
    suggestionContent: 'this function is far too long',
    improvedCode: '',
    brokenKodyRulesIds: [CONTEXT_RULE],
    ...over,
});

const makeStage = () => {
    const reviewOrchestrator = { execute: jest.fn() };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        reviewOrchestrator as any,
        {
            runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()),
        } as any,
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

const makeContext = (over: Record<string, unknown> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/user.ts', patch: PATCH }],
        codeReviewConfig: {
            reviewOptions: {},
            heavy: false,
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            kodyRules: [
                {
                    uuid: CONTEXT_RULE,
                    title: 'functions stay under 50 lines',
                    rule: 'A function must not exceed 50 lines.',
                    severity: 'high',
                    contextNeed: {
                        need: 'enclosing-scope',
                        sourceHash: 'h',
                        source: 'compiler',
                        inferredAt: new Date(0),
                    },
                },
                {
                    uuid: DIFF_ONLY_RULE,
                    title: 'no console.log',
                    rule: 'Do not use console.log.',
                    severity: 'high',
                    contextNeed: {
                        need: 'diff-only',
                        sourceHash: 'h',
                        source: 'compiler',
                        inferredAt: new Date(0),
                    },
                },
            ],
        },
        heavy: false,
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
        ...over,
    }) as any as CodeReviewPipelineContext;

const run = async (suggestions: any[], ctxOver: Record<string, unknown> = {}) => {
    const { stage, reviewOrchestrator } = makeStage();
    reviewOrchestrator.execute.mockResolvedValue({
        suggestions,
        agentResults: [],
        failures: [],
        incomplete: [],
        warnings: [],
    });
    return (stage as any).executeStage(makeContext(ctxOver)) as Promise<any>;
};

const inlineSuggestionsOf = (result: any): any[] =>
    (result.fileAnalysisResults ?? []).flatMap(
        (f: any) => f.codeReviewModelUsed?.suggestions ?? f.suggestions ?? [],
    );

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [0, 1, 2, 3] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
});

describe('#1826 — a whole-file finding is delivered as a PR comment', () => {
    it('marks an out-of-hunk finding from a context-needing rule file-anchored (KRC-32)', async () => {
        const result = await run([ruleFinding()]);

        const anchored = (result.validSuggestions ?? []).find(
            (s: any) => s.brokenKodyRulesIds?.[0] === CONTEXT_RULE,
        );
        expect(anchored).toBeDefined();
        expect(anchored.fileAnchored).toBe(true);
        // the cited lines are kept as the model gave them, NOT snapped onto
        // the hunk — the whole point is that they are outside it
        expect(anchored.relevantLinesStart).toBe(120);
        expect(anchored.relevantLinesEnd).toBe(180);
    });

    it('delivers it as one PR-level comment citing file:line (KRC-19)', async () => {
        const result = await run([ruleFinding()]);

        expect(result.validSuggestionsByPR).toHaveLength(1);
        expect(result.validSuggestionsByPR[0].suggestionContent).toContain(
            '`src/user.ts:120`',
        );
        expect(result.validSuggestionsByPR[0].suggestionContent).toContain(
            'this function is far too long',
        );
        // and NOT as an inline comment
        expect(inlineSuggestionsOf(result)).toEqual([]);
    });

    it('still discards an out-of-hunk finding from a diff-only rule (KRC-33)', async () => {
        const result = await run([
            ruleFinding({ brokenKodyRulesIds: [DIFF_ONLY_RULE] }),
        ]);

        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        expect(result.validSuggestions ?? []).toEqual([]);
        expect(
            (result.discardedSuggestions ?? []).some(
                (s: any) => s.brokenKodyRulesIds?.[0] === DIFF_ONLY_RULE,
            ),
        ).toBe(true);
    });

    it('still discards an out-of-hunk finding from a rule with no declared need', async () => {
        const result = await run([
            ruleFinding({ brokenKodyRulesIds: ['rule-never-inferred'] }),
        ]);

        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        expect(result.validSuggestions ?? []).toEqual([]);
    });

    it('discards a file-anchored finding naming a file outside the PR (KRC-20)', async () => {
        const result = await run([
            ruleFinding({ relevantFile: 'src/not-in-this-pr.ts' }),
        ]);

        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        expect(
            (result.discardedSuggestions ?? []).some(
                (s: any) => s.relevantFile === 'src/not-in-this-pr.ts',
            ),
        ).toBe(true);
    });

    it('leaves an in-hunk finding from the same rule inline, exactly as before', async () => {
        const result = await run([
            // the single hunk covers new-file lines 10-11
            ruleFinding({ relevantLinesStart: 10, relevantLinesEnd: 11 }),
        ]);

        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        const inline = (result.validSuggestions ?? [])[0];
        expect(inline).toBeDefined();
        expect(inline.fileAnchored).toBeUndefined();
        expect(inline.relevantLinesStart).toBe(10);
        expect(inline.relevantLinesEnd).toBe(11);
    });

    it('leaves a non-kody-rules out-of-hunk finding discarded, exactly as before', async () => {
        const result = await run([
            ruleFinding({ label: 'bug', brokenKodyRulesIds: [CONTEXT_RULE] }),
        ]);

        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        expect(result.validSuggestions ?? []).toEqual([]);
    });
});
