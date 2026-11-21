import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { resolveAgentPrompt } from '@libs/common/utils/codeManagement/suggestion-comment-blocks';
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
 * File-level suggestions reach ValidateSuggestionsStage, which keys every
 * committable-suggestion check on `suggestion.id` and skips an entry without
 * one. Only the PR-level path assigned an id, so inline suggestions were never
 * validated and never posted as committable suggestions.
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
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
        ...over,
    }) as any as CodeReviewPipelineContext;

const run = async (
    suggestions: any[],
    ctxOver: Record<string, unknown> = {},
) => {
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

describe('file-level suggestions carry an id for ValidateSuggestionsStage', () => {
    const inHunk = (over: Record<string, unknown> = {}) =>
        ruleFinding({
            relevantLinesStart: 11,
            relevantLinesEnd: 11,
            label: 'code_style',
            brokenKodyRulesIds: [],
            improvedCode: 'const b = 3;',
            ...over,
        });

    it('gives every inline suggestion a distinct non-empty id', async () => {
        const result = await run([
            inHunk(),
            inHunk({
                oneSentenceSummary: 'second',
                suggestionContent: 'second',
            }),
        ]);

        const ids = (result.validSuggestions ?? []).map((s: any) => s.id);
        expect(ids).toHaveLength(2);
        expect(ids.every((id: unknown) => typeof id === 'string' && id)).toBe(
            true,
        );
        expect(new Set(ids).size).toBe(2);
    });

    it('keeps an id the suggestion already had', async () => {
        const result = await run([inHunk({ id: 'keep-me' })]);

        expect(result.validSuggestions?.[0]?.id).toBe('keep-me');
    });
});
