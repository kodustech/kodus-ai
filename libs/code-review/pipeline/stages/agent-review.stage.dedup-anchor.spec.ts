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
 * #2157 — the dedup model keeps the finding with the most detail. On Azure
 * Repos #174 that was the one citing the whole function (14-32), so the
 * comment sat on the signature and the lines at fault (22-31) were listed
 * under "Also found in". The finding on the defective lines survives now, and
 * the range around it is not listed as another location.
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

const makeContext = () =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', fullName: 'acme/repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/bulkReassign.ts' }],
        codeReviewConfig: {
            reviewOptions: {},
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
        previousDecisions: [],
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
    }) as any as CodeReviewPipelineContext;

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

const published = (result: any) =>
    (result.fileAnalysisResults ?? []).flatMap(
        (f: any) => f.validSuggestionsToAnalyze ?? [],
    );

const onTheLoop = {
    relevantFile: 'src/bulkReassign.ts',
    relevantLinesStart: 22,
    relevantLinesEnd: 31,
    label: 'bug',
    severity: 'critical',
    oneSentenceSummary:
        'forEach with async callback returns before tickets are reassigned',
    suggestionContent:
        'The awaits inside the forEach callback are never awaited, so the counters are read before any ticket is processed.',
    existingCode: 'tickets.forEach(async (ticket) => {',
    improvedCode: 'for (const ticket of tickets) {',
};

const onTheFunction = {
    ...onTheLoop,
    relevantLinesStart: 14,
    relevantLinesEnd: 32,
    severity: 'high',
    oneSentenceSummary: '`forEach` does not await its async callback',
    suggestionContent:
        'The callback passed to forEach is async, so forEach never awaits it and the function returns its counters before any await resolves, always reporting zero reassigned tickets while rejections go unhandled.',
    existingCode: 'export async function bulkReassign(',
};

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockImplementation((async (req: any) =>
            req.spanName === 'code-review::dedup'
                ? { groups: [{ keep: 1, duplicates: [0] }], unique: [] }
                : { verdicts: [] }) as any);
    jest.spyOn(
        AgentReviewStage.prototype as any,
        'resolveDedupMerge',
    ).mockResolvedValue({
        honor: true,
        reason: 'test',
        score: 1,
    });
});
afterEach(() => {
    runSpy.mockRestore();
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

describe('AgentReviewStage — dedup anchor (#2157)', () => {
    it('anchors the merged comment on the defective lines, not on the whole function', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([onTheLoop, onTheFunction]),
        );

        const result = await (stage as any).executeStage(makeContext());
        const published = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.validSuggestionsToAnalyze ?? [],
        );

        expect(published).toHaveLength(1);
        expect(published[0]).toEqual(
            expect.objectContaining({
                relevantLinesStart: 22,
                relevantLinesEnd: 31,
                existingCode: onTheLoop.existingCode,
            }),
        );
        expect(published[0].suggestionContent).not.toContain('Also found in');
    });

    // Review of #2181: the model may list a duplicate in `unique` too, which
    // the schema accepts. Promoting it made the group's keep an index already
    // published, so the stage absorbed the original keep without the content
    // guard and a different bug on the wider range disappeared.
    it('keeps the content guard when the narrower duplicate is also in unique', async () => {
        const bugA = {
            ...onTheFunction,
            relevantLinesStart: 10,
            relevantLinesEnd: 30,
            oneSentenceSummary: 'Token is logged in plain text',
            suggestionContent: 'The auth token is written to the request log.',
            existingCode: 'log(req)',
        };
        const bugB = {
            ...onTheLoop,
            relevantLinesStart: 20,
            relevantLinesEnd: 21,
        };
        runSpy.mockImplementation((async (req: any) =>
            req.spanName === 'code-review::dedup'
                ? { groups: [{ keep: 0, duplicates: [1] }], unique: [1] }
                : { verdicts: [] }) as any);
        (AgentReviewStage.prototype as any).resolveDedupMerge.mockResolvedValue(
            {
                honor: false,
                reason: 'different bugs',
                score: 0,
            },
        );
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(envelope([bugA, bugB]));

        const result = await (stage as any).executeStage(makeContext());
        const published = (result.fileAnalysisResults ?? []).flatMap(
            (f: any) => f.validSuggestionsToAnalyze ?? [],
        );

        expect(published.map((s: any) => s.existingCode).sort()).toEqual(
            [bugA.existingCode, bugB.existingCode].sort(),
        );
    });
});
