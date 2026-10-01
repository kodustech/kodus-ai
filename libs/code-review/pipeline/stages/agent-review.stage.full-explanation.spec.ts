import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

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
 * The formatter shortens `suggestionContent` for people reading the PR. The
 * full explanation the finder wrote survives as `fullExplanation` (labels
 * stripped, no model call) and is what `llmPrompt` is built from, so the
 * "Prompt for LLM" block and the agent surfaces keep the whole reasoning.
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

const RAW = 'WHAT: The user object can be null when the account was deleted. WHY: Reading name throws and the request fails with a 500. HOW: Guard with optional chaining and return a 404.';
const STRIPPED =
    'The user object can be null when the account was deleted. Reading name throws and the request fails with a 500. Guard with optional chaining and return a 404.';

describe('AgentReviewStage — full explanation', () => {
    it('keeps the raw explanation without labels when the formatter shortens the body', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ suggestionContent: RAW })]),
        );
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
            new Map([[0, { suggestionContent: 'The user can be null. Guard it.' }]]),
        );

        const [s] = analyzedSuggestions(await run(stage, makeContext()));

        expect(s.suggestionContent).toBe('The user can be null. Guard it.');
        expect(s.fullExplanation).toBe(STRIPPED);
    });

    it('builds llmPrompt from the title and the full explanation, not the short body', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ suggestionContent: RAW })]),
        );
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
            new Map([[0, { suggestionContent: 'The user can be null. Guard it.' }]]),
        );

        const [s] = analyzedSuggestions(await run(stage, makeContext()));

        expect(s.llmPrompt).toBe(
            `user object can be null and is dereferenced\n\n${STRIPPED}`,
        );
    });

    it('carries the full explanation on PR-level findings', async () => {
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
                    suggestionContent: RAW,
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestionsByPR[0].fullExplanation).toBe(STRIPPED);
    });
});
