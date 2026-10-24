import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';

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
 * #1821 — after the finder, in order: the parse schema discards a suggestion
 * missing a lean field, anchoring discards one outside the PR's hunks or on a
 * file the PR does not change, a label off the list becomes `bug` and a label
 * the team turned off is discarded. Only what survives reaches the dedup.
 */
const envelope = (suggestions: any[]) => ({
    suggestions,
    agentResults: [],
    failures: [],
    incomplete: [],
    warnings: [],
});

const makeStage = () => {
    const reviewOrchestrator = { execute: jest.fn() };
    const historyUseCase = {
        execute: jest.fn().mockResolvedValue([]),
    };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
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
        undefined,
        undefined,
        historyUseCase as any,
    );
    return { stage, reviewOrchestrator, historyUseCase };
};

const makeContext = (reviewOptions: Record<string, boolean> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', fullName: 'acme/repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [
            {
                filename: 'src/orders.ts',
                patch: '@@ -10,2 +10,4 @@\n const total = 0;\n+for (const item of items) total += item.price;\n+return total;\n }',
            },
        ],
        codeReviewConfig: {
            reviewOptions,
            heavy: false,
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            kodyRules: [
                {
                    uuid: 'rule-logger',
                    title: 'Use the logger',
                    rule: 'Log through the logger, never console.log.',
                    severity: 'high',
                },
            ],
        },
        heavy: false,
        previousDecisions: [],
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
    }) as any as CodeReviewPipelineContext;

const kept = {
    relevantFile: 'src/orders.ts',
    relevantLinesStart: 11,
    relevantLinesEnd: 12,
    label: 'criticism',
    suggestionContent: 'The total ignores the quantity of each item.',
};
const noLines = {
    relevantFile: 'src/orders.ts',
    label: 'bug',
    suggestionContent: 'Missing its lines.',
};
const outsideHunks = {
    ...kept,
    label: 'bug',
    relevantLinesStart: 200,
    relevantLinesEnd: 201,
    suggestionContent: 'Cites lines this PR did not touch.',
};
const otherFile = {
    ...kept,
    label: 'bug',
    relevantFile: 'src/unchanged.ts',
    suggestionContent: 'Cites a file this PR did not change.',
};

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockImplementation((async () => ({ verdicts: [] })) as any);
});
afterEach(() => {
    runSpy.mockRestore();
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

describe('AgentReviewStage — after the finder (#1821)', () => {
    it('parses, anchors and normalizes the label before the dedup', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([kept, noLines, outsideHunks, otherFile]),
        );

        const result = await (stage as any).executeStage(makeContext());

        const published = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.validSuggestionsToAnalyze ?? [],
        );
        expect(published).toHaveLength(1);
        expect(published[0]).toEqual(
            expect.objectContaining({
                label: 'bug',
                suggestionContent: kept.suggestionContent,
            }),
        );
    });

    it('enriches the suggestions that reach the team with a title, the cited code and the fix', async () => {
        runSpy.mockImplementation((async (req: any) =>
            req.runName === 'code-review-enrich'
                ? {
                      title: 'Total ignores item quantity',
                      fixStatus: 'local',
                      improvedCode: 'for (const item of items) total += item.price * item.qty;',
                  }
                : { verdicts: [] }) as any);
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(envelope([{ ...kept, label: 'bug' }]));

        const result = await (stage as any).executeStage(makeContext());

        const enrichCalls = runSpy.mock.calls.filter(
            ([req]: any[]) => req.runName === 'code-review-enrich',
        );
        expect(enrichCalls).toHaveLength(1);
        expect(enrichCalls[0][0].user).toContain(kept.suggestionContent);
        const published = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.validSuggestionsToAnalyze ?? [],
        );
        expect(published).toHaveLength(1);
        expect(published[0]).toEqual(
            expect.objectContaining({
                oneSentenceSummary: 'Total ignores item quantity',
                improvedCode:
                    'for (const item of items) total += item.price * item.qty;',
            }),
        );
    });

    it('discards a suggestion in a category the team turned off, never moving it to one that is on', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        const perf = { ...kept, label: 'performance', suggestionContent: 'Loops twice over the items.' };
        const invented = { ...kept, suggestionContent: 'An invented label becomes bug, which is off.' };
        const security = { ...kept, label: 'security', suggestionContent: 'The price comes from the client.' };
        reviewOrchestrator.execute.mockResolvedValue(envelope([perf, invented, security]));

        const result = await (stage as any).executeStage(
            makeContext({ bug: false, performance: false }),
        );

        const published = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.validSuggestionsToAnalyze ?? [],
        );
        expect(published.map((s: any) => s.label)).toEqual(['security']);
        const discarded = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.discardedSuggestionsBySafeGuard ?? [],
        );
        expect(
            discarded
                .filter((s: any) => s.priorityStatus === 'discarded-by-category')
                .map((s: any) => s.label)
                .sort(),
        ).toEqual(['bug', 'performance']);
    });
});
