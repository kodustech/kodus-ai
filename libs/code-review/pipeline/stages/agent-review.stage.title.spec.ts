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
 * Every published finding carries a bounded title in `oneSentenceSummary`.
 * `suggestion-title.spec.ts` covers the rules; this suite proves the stage
 * applies them to every finding before the PR-level / file-level split.
 */

const sugg = (over: Record<string, unknown> = {}) => ({
    relevantFile: 'src/user.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    label: 'bug',
    severity: 'high',
    oneSentenceSummary: 'user object can be null and is dereferenced',
    suggestionContent: 'user object can be null and is dereferenced here',
    existingCode: 'const name = user.name;',
    improvedCode: 'const name = user?.name;',
    ...over,
});

const happyEnvelope = (suggestions: any[]) => ({
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

const analyzedSuggestions = (result: any) =>
    (result.fileAnalysisResults ?? []).flatMap(
        (f: any) => f.validSuggestionsToAnalyze ?? [],
    );

let runSpy: jest.SpyInstance;
beforeEach(() => {
    // Dedup's LLM.run: keep-all so every suggestion in the envelope survives
    // to the gate under test.
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [0, 1, 2, 3] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
});

describe('AgentReviewStage — suggestion title', () => {
    it('builds the title from the first sentence of the body when the summary is missing', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    oneSentenceSummary: '',
                    suggestionContent:
                        'The user object can be null here. Guard it before reading name.',
                }),
            ]),
        );

        const analyzed = analyzedSuggestions(await run(stage, makeContext()));

        expect(analyzed).toHaveLength(1);
        expect(analyzed[0].oneSentenceSummary).toBe(
            'The user object can be null here',
        );
    });

    it('cuts a summary longer than the title ceiling', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        const longSummary =
            'The user object returned by the repository lookup can be null when the account was deleted, and it is dereferenced without a guard';
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ oneSentenceSummary: longSummary })]),
        );

        const analyzed = analyzedSuggestions(await run(stage, makeContext()));

        expect(analyzed[0].oneSentenceSummary.length).toBeLessThanOrEqual(100);
        expect(analyzed[0].oneSentenceSummary.endsWith('…')).toBe(true);
    });

    it('titles PR-level findings too', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    label: 'kody_rules',
                    relevantFile: undefined,
                    relevantLinesStart: undefined,
                    relevantLinesEnd: undefined,
                    existingCode: '',
                    improvedCode: '',
                    brokenKodyRulesIds: ['rule-1'],
                    oneSentenceSummary: null,
                    suggestionContent:
                        'The PR description has no ticket reference. Add one.',
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestionsByPR).toHaveLength(1);
        expect(result.validSuggestionsByPR[0].oneSentenceSummary).toBe(
            'The PR description has no ticket reference',
        );
    });
});
