import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
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
 * Issue #1833 — end-to-end wiring of the `improvedCode` publication gate
 * inside AgentReviewStage. `is-usable-fix.spec.ts` covers `checkFix` in
 * isolation; this suite proves the stage actually calls it at the right
 * point, on the right fields, and produces the right observable outcome: a
 * bad-fix finding never reaches `fileAnalysisResults` (so it can never be
 * posted to the PR), lands in `discardedSuggestions` tagged
 * `DISCARDED_BY_BAD_FIX` with a delivery status (never a silent drop), and a
 * `BAD_FIX_DROPPED` review warning is attached to the context.
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

const badFixDiscards = (result: any) =>
    (result.discardedSuggestions ?? []).filter(
        (s: any) => s.priorityStatus === PriorityStatus.DISCARDED_BY_BAD_FIX,
    );

describe('AgentReviewStage — improvedCode publication gate (#1833)', () => {
    it('drops a suggestion whose improvedCode is empty', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([sugg({ improvedCode: '' })]),
        );

        const result = await run(stage, makeContext());

        expect(result.validSuggestions ?? []).toHaveLength(0);
        // The file still gets an entry (so its discarded suggestion is
        // observable), just with nothing left to analyze/post.
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(
            result.fileAnalysisResults[0].validSuggestionsToAnalyze,
        ).toHaveLength(0);
        const discarded = badFixDiscards(result);
        expect(discarded).toHaveLength(1);
        expect(discarded[0].deliveryStatus).toBe('not_sent');
    });

    it('drops a suggestion whose improvedCode is byte-identical to existingCode', async () => {
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

        expect(
            (result.fileAnalysisResults ?? []).flatMap(
                (f: any) => f.validSuggestionsToAnalyze,
            ),
        ).toHaveLength(0);
        expect(badFixDiscards(result)).toHaveLength(1);
    });

    it('drops a prose-only improvedCode', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(
            happyEnvelope([
                sugg({
                    existingCode: 'catch (e) { console.log(e); }',
                    improvedCode:
                        '// re-throw the error here instead of swallowing it',
                }),
            ]),
        );

        const result = await run(stage, makeContext());

        expect(
            (result.fileAnalysisResults ?? []).flatMap(
                (f: any) => f.validSuggestionsToAnalyze,
            ),
        ).toHaveLength(0);
        expect(badFixDiscards(result)).toHaveLength(1);
    });

    it('drops a truncated improvedCode (the literal issue #1833 example)', async () => {
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

        expect(
            (result.fileAnalysisResults ?? []).flatMap(
                (f: any) => f.validSuggestionsToAnalyze,
            ),
        ).toHaveLength(0);
        expect(badFixDiscards(result)).toHaveLength(1);
    });

    it('keeps a suggestion with a real, usable fix', async () => {
        const { stage, reviewOrchestrator } = makeStage();
        reviewOrchestrator.execute.mockResolvedValue(happyEnvelope([sugg()]));

        const result = await run(stage, makeContext());

        expect(badFixDiscards(result)).toHaveLength(0);
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(
            result.fileAnalysisResults[0].validSuggestionsToAnalyze,
        ).toHaveLength(1);
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

        expect(badFixDiscards(result)).toHaveLength(0);
    });

    it('records a BAD_FIX_DROPPED review warning with the drop count, and keeps the usable suggestion alongside it', async () => {
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

        expect(badFixDiscards(result)).toHaveLength(1);
        expect(result.fileAnalysisResults).toHaveLength(1);
        expect(
            result.fileAnalysisResults[0].validSuggestionsToAnalyze,
        ).toHaveLength(1);

        const warnings = result.reviewWarnings ?? [];
        const badFixWarning = warnings.find(
            (w: any) => w.kind === 'BAD_FIX_DROPPED',
        );
        expect(badFixWarning).toBeDefined();
        expect(badFixWarning.detail).toContain('1 suggestion(s)');
    });
});
