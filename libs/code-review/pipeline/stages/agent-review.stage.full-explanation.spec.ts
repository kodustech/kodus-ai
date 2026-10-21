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

const RAW =
    'WHAT: The user object can be null when the account was deleted. WHY: Reading name throws and the request fails with a 500. HOW: Guard with optional chaining and return a 404.';
const STRIPPED =
    'The user object can be null when the account was deleted. Reading name throws and the request fails with a 500. Guard with optional chaining and return a 404.';

describe('AgentReviewStage — full explanation', () => {
    it('keeps the raw explanation without labels when the formatter shortens the body', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ suggestionContent: RAW })]),
        );
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
            new Map([
                [0, { suggestionContent: 'The user can be null. Guard it.' }],
            ]),
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
            new Map([
                [0, { suggestionContent: 'The user can be null. Guard it.' }],
            ]),
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

describe('formatter fallback preserves impact and action', () => {
    it.each(['empty', 'throws'])(
        '%s formatter preserves WHY and HOW',
        async (mode) => {
            const { stage, reviewOrchestrator } = makeStage();
            reviewOrchestrator.execute.mockResolvedValue(
                happyEnvelope([sugg({ suggestionContent: RAW })]),
            );
            if (mode === 'throws')
                (formatSuggestionContent as jest.Mock).mockRejectedValueOnce(
                    new Error('formatter failed'),
                );
            else
                (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
                    new Map(),
                );
            const [s] = analyzedSuggestions(await run(stage, makeContext()));
            expect(s.suggestionContent).toBe(
                'Reading name throws and the request fails with a 500. Guard with optional chaining and return a 404.',
            );
            expect(s.fullExplanation).toBe(STRIPPED);
        },
    );
    it('cites the file in agent-facing promoted findings', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    label: 'kody_rules',
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
        expect(result.validSuggestionsByPR[0].fullExplanation).toBe(
            '`src/user.ts` — ' + STRIPPED,
        );
    });
});

describe('custom guideline fallback', () => {
    it('keeps the full body for real custom guidelines', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ suggestionContent: RAW })]),
        );
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(new Map());
        const ctx = makeContext();
        const custom = frozenContext({
            ...ctx,
            codeReviewConfig: {
                ...ctx.codeReviewConfig,
                v2PromptOverrides: {
                    generation: {
                        main: 'Explain all details in three sentences.',
                    },
                },
            },
        }) as unknown as CodeReviewPipelineContext;
        const [s] = analyzedSuggestions(await run(stage, custom));
        expect(s.suggestionContent).toBe(STRIPPED);
    });
});

describe('summary-less fallback title', () => {
    it.each(['empty', 'throws'])(
        'uses the original problem when formatting %s',
        async (mode) => {
            const { stage, reviewOrchestrator } = makeStage();
            reviewOrchestrator.execute.mockResolvedValue(
                happyEnvelope([
                    sugg({ oneSentenceSummary: '', suggestionContent: RAW }),
                ]),
            );
            if (mode === 'throws')
                (formatSuggestionContent as jest.Mock).mockRejectedValueOnce(
                    new Error('formatter failed'),
                );
            else
                (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
                    new Map(),
                );
            const [s] = analyzedSuggestions(await run(stage, makeContext()));
            expect(s.oneSentenceSummary).toBe(
                'The user object can be null when the account was deleted',
            );
            expect(s.suggestionContent).toBe(
                'Reading name throws and the request fails with a 500. Guard with optional chaining and return a 404.',
            );
            expect(s.fullExplanation).toBe(STRIPPED);
            expect(s.llmPrompt).toBe(s.oneSentenceSummary + '\n\n' + STRIPPED);
        },
    );
});

describe('fallback title excludes fenced source', () => {
    it.each([
        [
            '```ts\nconst name = user.name;\n```\nThe user can be null. Guard it.',
            'The user can be null',
        ],
        [
            'The user ```ts\nuser.name;\n``` can be null. Guard it.',
            'The user can be null',
        ],
        [
            '```ts\nuser.name;\n```\n' + RAW,
            'The user object can be null when the account was deleted',
        ],
    ])('derives prose from %s', async (raw, title) => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({ oneSentenceSummary: '', suggestionContent: raw }),
            ]),
        );
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(new Map());
        const [s] = analyzedSuggestions(await run(stage, makeContext()));
        expect(s.oneSentenceSummary).toBe(title);
        expect(s.oneSentenceSummary).not.toContain('```');
        expect(s.fullExplanation).toContain('```ts');
        expect(s.llmPrompt).toContain('```ts');
    });
});

describe('agent-facing text keeps what the comment adds after formatting', () => {
    const rule = {
        uuid: 'rule-1',
        title: 'Guard nullable users',
        rule: 'Dereference a user only after checking it exists.',
        severity: 'high',
    };
    const ctxWithRule = (over: Record<string, unknown> = {}) =>
        makeContext({
            codeReviewConfig: {
                reviewOptions: {},
                heavy: false,
                resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
                kodyRules: [rule],
            },
            ...over,
        });

    it('the rule link reaches the full explanation and the prompt', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-1'],
                    suggestionContent: RAW,
                }),
            ]),
        );

        const [s] = analyzedSuggestions(await run(stage, ctxWithRule()));

        expect(s.suggestionContent).toContain(
            'Kody rule violation: [Guard nullable users]',
        );
        expect(s.fullExplanation).toContain(
            'Kody rule violation: [Guard nullable users]',
        );
        expect(s.llmPrompt.match(/Kody rule violation/g)).toHaveLength(1);
    });

    it('the revision reference reaches the full explanation, and the prompt once', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    suggestionContent: RAW,
                    revisesSuggestionId: 'prior-1',
                }),
            ]),
        );

        const [s] = analyzedSuggestions(
            await run(
                stage,
                makeContext({
                    previousDecisions: [
                        {
                            suggestionId: 'prior-1',
                            relevantFile: 'src/user.ts',
                            relevantLinesStart: 10,
                            suggestionContent: 'Earlier fix.',
                            label: 'bug',
                            outcome: 'implemented',
                            decidedAt: '2026-10-03T10:00:00Z',
                        },
                    ],
                }),
            ),
        );

        expect(s.fullExplanation).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\*/,
        );
        expect(
            s.llmPrompt.match(/Revises an earlier Kody suggestion/g),
        ).toHaveLength(1);
    });

    it('a merged finding with no text of its own is not titled with its location list', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        const empty = {
            label: 'kody_rules',
            brokenKodyRulesIds: ['rule-1'],
            oneSentenceSummary: '',
            suggestionContent: '',
            existingCode: '',
            improvedCode: '',
        };
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    ...empty,
                    relevantLinesStart: 10,
                    relevantLinesEnd: 10,
                }),
                sugg({
                    ...empty,
                    relevantLinesStart: 12,
                    relevantLinesEnd: 12,
                }),
            ]),
        );

        const analyzed = analyzedSuggestions(await run(stage, ctxWithRule()));

        for (const s of analyzed) {
            expect(s.oneSentenceSummary).not.toMatch(/Also found in/);
        }
    });
});
