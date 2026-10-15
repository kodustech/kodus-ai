import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { LLM } from '@libs/llm/llm';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

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
 * #2097 — the repeat check inside AgentReviewStage: it reads the PR's whole
 * history (not only the prompts' 40 most recent) and keeps a repeat out of
 * the review as `discarded-by-repeat`, whatever the earlier comment's status.
 * `repeat-check.spec.ts` covers the decision itself.
 */

const earlier = (over: Partial<PrDecisionRecord>): PrDecisionRecord => ({
    suggestionId: 'old',
    relevantFile: 'src/user.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 10,
    suggestionContent: 'Earlier comment.',
    label: 'bug',
    outcome: 'pending',
    decidedAt: '2026-10-01T10:00:00Z',
    ...over,
});

const ruleComment = earlier({
    suggestionId: 'old-rule',
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-logger'],
    existingCode: "console.log('user', user)",
    suggestionContent: 'Use the logger instead of console.log.',
});

const ruleFinding = {
    relevantFile: 'src/user.ts',
    relevantLinesStart: 14,
    relevantLinesEnd: 14,
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-logger'],
    severity: 'high',
    oneSentenceSummary: 'console.log instead of the logger',
    suggestionContent: 'Use the logger instead of console.log.',
    existingCode: "console.log('user',  user)",
    improvedCode: "logger.info({ user }, 'user')",
};

const bugFinding = {
    relevantFile: 'src/user.ts',
    relevantLinesStart: 20,
    relevantLinesEnd: 22,
    label: 'bug',
    severity: 'high',
    oneSentenceSummary: 'user can be null and is dereferenced',
    suggestionContent: 'user can be null and is dereferenced here',
    existingCode: 'const name = user.name;',
    improvedCode: 'const name = user?.name;',
};

const envelope = (suggestions: any[]) => ({
    suggestions,
    agentResults: [],
    failures: [],
    incomplete: [],
    warnings: [],
});

const makeStage = (wholeHistory: PrDecisionRecord[]) => {
    const reviewOrchestrator = { execute: jest.fn() };
    const historyUseCase = {
        execute: jest.fn().mockResolvedValue(wholeHistory),
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

const makeContext = (previousDecisions: PrDecisionRecord[]) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', fullName: 'acme/repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/user.ts' }],
        codeReviewConfig: {
            reviewOptions: {},
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
        previousDecisions,
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

let runSpy: jest.SpyInstance;
let repeatAnswer: unknown;
beforeEach(() => {
    repeatAnswer = { verdicts: [] };
    runSpy = jest.spyOn(LLM, 'run').mockImplementation((async (req: any) =>
        req.spanName === 'code-review::repeat-check'
            ? repeatAnswer
            : { groups: [], unique: [0, 1, 2, 3] }) as any);
});
afterEach(() => {
    runSpy.mockRestore();
    jest.clearAllMocks();
});

describe('AgentReviewStage — repeat check (#2097)', () => {
    it('reads the whole history and keeps a rule repeat older than the prompts\' history out of the review', async () => {
        const recent = Array.from({ length: 3 }, (_, i) =>
            earlier({ suggestionId: `recent-${i}`, relevantFile: 'src/other.ts' }),
        );
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([
            ...recent,
            ruleComment,
        ]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext(recent));

        expect(historyUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 7,
                repositoryFullName: 'acme/repo-1',
                limit: 500,
            }),
        );
        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions).toEqual([
            expect.objectContaining({
                existingCode: ruleFinding.existingCode,
                priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
                deliveryStatus: 'not_sent',
            }),
        ]);
    });

    it('keeps a bug still there after its comment was applied out of the review', async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            existingCode: 'const name = user.name;',
            suggestionContent: 'user can be null here.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([bugFinding]));
        repeatAnswer = { verdicts: [{ finding: 0, verdict: 'same_occurrence', earlierId: 'old-bug' }] };

        const result = await run(stage, makeContext([applied]));

        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions).toEqual([
            expect.objectContaining({
                existingCode: bugFinding.existingCode,
                priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
            }),
        ]);
    });

    it('posts a bug the check does not match, with the revision link its finder chose', async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            suggestionContent: 'Return early when user is missing.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([{ ...bugFinding, revisesSuggestionId: 'old-bug' }]),
        );

        const result = await run(stage, makeContext([applied]));

        const [comment] = published(result);
        expect(comment.suggestionContent).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\* on `src\/user\.ts:10`/,
        );
    });

    it('a PR without history is not checked', async () => {
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([
            ruleComment,
        ]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext([]));

        expect(historyUseCase.execute).not.toHaveBeenCalled();
        expect(published(result)).toHaveLength(1);
    });

    it('falls back to the prompts\' history when the whole history cannot be read', async () => {
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([]);
        historyUseCase.execute.mockRejectedValue(new Error('Mongo down'));
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext([ruleComment]));

        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions[0].priorityStatus).toBe(
            PriorityStatus.DISCARDED_BY_REPEAT,
        );
    });
});
