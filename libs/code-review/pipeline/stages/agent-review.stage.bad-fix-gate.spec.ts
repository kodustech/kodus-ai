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
 * Issue #1833 — end-to-end wiring of the `improvedCode` publication gate
 * inside AgentReviewStage. `is-usable-fix.spec.ts` covers `checkFix` in
 * isolation; this suite proves the stage actually calls it at the right
 * point, on the right fields, and produces the right observable outcome: a
 * bad-fix finding is never dropped — it is still published, with
 * `improvedCode` stripped so the renderer skips the code block — and a
 * `BAD_FIX_DOWNGRADED` review warning is attached to the context.
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

describe('AgentReviewStage — improvedCode publication gate (#1833)', () => {
    it('adds the revision reference after formatting to both the comment and the correction prompt', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    revisesSuggestionId: 'prior-1',
                    llmPrompt: 'Raw finding.',
                }),
            ]),
        );
        const { formatSuggestionContent } = jest.requireMock(
            '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
        );
        formatSuggestionContent.mockResolvedValueOnce(
            new Map([[0, { suggestionContent: 'Formatted finding.' }]]),
        );
        const result = await run(
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
        );
        const [published] = analyzedSuggestions(result);
        expect(published.suggestionContent).toContain(
            'Revises an earlier Kody suggestion',
        );
        expect(published.suggestionContent).toContain('Formatted finding.');
        // The prompt carries the title and the whole explanation rather than
        // the formatted body, and the same reference leads it.
        expect(published.llmPrompt).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\*/,
        );
        expect(published.llmPrompt).toContain(published.oneSentenceSummary);
        expect(published.fullExplanation).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\*/,
        );
        expect(published.llmPrompt.match(/Revises an earlier/g)).toHaveLength(
            1,
        );
        expect(published.llmPrompt).toContain(
            published.fullExplanation.split('\n\n').slice(1).join('\n\n'),
        );
    });

    it('assigns distinct suggestion IDs to PR-level findings of the same rule across rounds', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        const envelope = () =>
            happyEnvelope([
                sugg({
                    label: 'kody_rules',
                    relevantFile: undefined,
                    relevantLinesStart: undefined,
                    relevantLinesEnd: undefined,
                    improvedCode: '',
                    brokenKodyRulesIds: ['rule-1'],
                }),
            ]);
        reviewOrchestrator.execute.mockImplementation(envelope);
        const first = await run(stage, makeContext());
        const second = await run(stage, makeContext());
        expect(first.validSuggestionsByPR).toHaveLength(1);
        expect(second.validSuggestionsByPR).toHaveLength(1);
        expect(first.validSuggestionsByPR[0].id).not.toBe('rule-1');
        expect(first.validSuggestionsByPR[0].id).not.toBe(
            second.validSuggestionsByPR[0].id,
        );
        expect(first.validSuggestionsByPR[0].brokenKodyRulesIds).toEqual([
            'rule-1',
        ]);
    });

    it('downgrades an empty improvedCode to a plain comment instead of dropping it', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ improvedCode: '' })]),
        );

        const result = await run(stage, makeContext());

        // Nothing is discarded — the finding still ships, just without code.
        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        const analyzed = analyzedSuggestions(result);
        expect(analyzed).toHaveLength(1);
        expect(analyzed[0].improvedCode).toBe('');
    });

    it('downgrades a byte-identical improvedCode to a plain comment', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    existingCode: 'const name = user.name;',
                    improvedCode: '  const name = user.name;\n',
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        const analyzed = analyzedSuggestions(result);
        expect(analyzed).toHaveLength(1);
        expect(analyzed[0].improvedCode).toBe('');
    });

    it('downgrades a truncated improvedCode (the literal issue #1833 example)', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    existingCode:
                        'function parseConfig(raw) {\n  return JSON.parse(raw);\n}',
                    improvedCode:
                        'function parseConfig(raw) {\n  try {\n    return JSON.parse(raw);\n  } catch {\n    return safe default pa',
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        const analyzed = analyzedSuggestions(result);
        expect(analyzed).toHaveLength(1);
        expect(analyzed[0].improvedCode).toBe('');
    });

    it('keeps a suggestion with a real, usable fix untouched', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));

        const result = await run(stage, makeContext());

        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        const analyzed = analyzedSuggestions(result);
        expect(analyzed).toHaveLength(1);
        expect(analyzed[0].improvedCode).toBe('const name = user?.name;');
    });

    it('does not gate a PR-level Kody Rule finding with no existingCode to replace', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    label: 'kody_rules',
                    relevantFile: undefined,
                    relevantLinesStart: undefined,
                    relevantLinesEnd: undefined,
                    existingCode: undefined,
                    improvedCode: undefined,
                    brokenKodyRulesIds: ['rule-1'],
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        const warnings = result.reviewWarnings ?? [];
        expect(
            warnings.find((w: any) => w.kind === 'BAD_FIX_DOWNGRADED'),
        ).toBeUndefined();
    });

    it('records a BAD_FIX_DOWNGRADED review warning with the count, and publishes both suggestions', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({ relevantLinesStart: 10, relevantLinesEnd: 12 }),
                sugg({
                    relevantLinesStart: 20,
                    relevantLinesEnd: 22,
                    existingCode: 'const x = compute();',
                    improvedCode: '',
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(result.discardedSuggestions ?? []).toHaveLength(0);
        expect(result.fileAnalysisResults).toHaveLength(1);
        const analyzed = analyzedSuggestions(result);
        expect(analyzed).toHaveLength(2);
        expect(analyzed.filter((s: any) => s.improvedCode === '')).toHaveLength(
            1,
        );

        const warnings = result.reviewWarnings ?? [];
        const badFixWarning = warnings.find(
            (w: any) => w.kind === 'BAD_FIX_DOWNGRADED',
        );
        expect(badFixWarning).toBeDefined();
        expect(badFixWarning.detail).toContain('1 suggestion(s)');
    });
});
