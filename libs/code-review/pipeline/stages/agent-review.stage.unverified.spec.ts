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
 * #2171 — a review whose agent did not finish, or whose findings could not be
 * verified, is not a clean review. The run stores the unverified findings as
 * such and records a 'partial' error, which holds auto-approve.
 */

const makeStage = (
    orchestratorOutput: Record<string, unknown>,
    graph: { generateContextLegacy?: jest.Mock } = {},
) => {
    const reviewOrchestrator = {
        execute: jest.fn().mockResolvedValue(orchestratorOutput),
    };
    const graphContext = {
        generateContext: jest.fn(),
        generateContextLegacy:
            graph.generateContextLegacy ?? jest.fn().mockResolvedValue(''),
    };
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
        graphContext as any,
        { isEnabled: jest.fn().mockResolvedValue(false) } as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any,
    );
    return { stage, graphContext };
};

const sandbox = () => ({
    type: 'local',
    baseBranch: 'main',
    run: jest.fn(),
    remoteCommands: { grep: jest.fn(), readFile: jest.fn() },
});

const makeContext = (over: Record<string, unknown> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/user.ts' }],
        codeReviewConfig: {
            reviewOptions: {},
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
        },
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
        ...over,
    }) as any as CodeReviewPipelineContext;

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

const kinds = (result: any) =>
    (result.reviewWarnings ?? []).map((w: any) => w.kind);

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
});

describe('AgentReviewStage — unfinished checks (#2171)', () => {
    const unverifiedFinding = {
        relevantFile: 'src/user.ts',
        suggestionContent: 'Unchecked claim',
        oneSentenceSummary: 'unchecked',
        severity: 'high',
        label: 'bug',
    };

    it('stores findings whose verify run failed as discarded-by-verify-error, not sent', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [
                {
                    suggestions: [],
                    agentName: 'kodus-generalist',
                    agentCategory: 'generalist',
                    turnsUsed: 3,
                    durationMs: 1,
                    discardedByVerifyError: [unverifiedFinding],
                },
            ],
            failures: [],
            incomplete: [],
            unverified: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    unverifiedCount: 1,
                },
            ],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const stored = (result.discardedSuggestions ?? []).find(
            (s: any) => s.suggestionContent === 'Unchecked claim',
        );
        expect(stored).toMatchObject({
            priorityStatus: 'discarded-by-verify-error',
            deliveryStatus: 'not_sent',
        });
        expect(
            (result.validSuggestions ?? []).map(
                (s: any) => s.suggestionContent,
            ),
        ).not.toContain('Unchecked claim');
    });

    it('records a partial error for a core agent that left findings unverified', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [],
            incomplete: [],
            unverified: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    unverifiedCount: 2,
                },
            ],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(error?.severity).toBe('partial');
        expect(String(error?.error?.message)).toContain('could not verify 2');
    });

    it('records a partial error for a core agent whose turn was truncated', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [],
            incomplete: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    finishReason: 'truncated',
                    suggestionsFound: 0,
                    durationMs: 10,
                },
            ],
            unverified: [],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(error?.severity).toBe('partial');
        expect(String(error?.error?.message)).toContain(
            'truncated by the model provider',
        );
    });

    it('does not gate the review on kody-rules leaving findings unverified', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [],
            incomplete: [],
            unverified: [
                {
                    agentName: 'kody-rules',
                    category: 'kody_rules',
                    unverifiedCount: 1,
                },
            ],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        expect(
            (result.errors ?? []).find(
                (e: any) => e.substage === 'agent:kody-rules',
            ),
        ).toBeUndefined();
    });
});
