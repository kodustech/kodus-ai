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
 * #2066 — a review that ran without its repository checkout, or whose call
 * graph failed, still succeeds. These pin that the run records it, so the
 * dashboard and the doctor can tell it apart from a full review.
 */

const envelope = () => ({
    suggestions: [],
    agentResults: [],
    failures: [],
    incomplete: [],
    warnings: [],
});

const makeStage = (graph: { generateContextLegacy?: jest.Mock } = {}) => {
    const reviewOrchestrator = {
        execute: jest.fn().mockResolvedValue(envelope()),
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

describe('AgentReviewStage — losses the run records (#2066)', () => {
    it('records a review that ran without the repository checked out', async () => {
        const { stage } = makeStage();

        const result = await run(stage, makeContext());

        expect(kinds(result)).toContain('SANDBOX_UNAVAILABLE');
        const warning = result.reviewWarnings.find(
            (w: any) => w.kind === 'SANDBOX_UNAVAILABLE',
        );
        expect(warning.reason).toBe('sandbox_unavailable');
    });

    it('records a null sandbox (no provider) as a review without a checkout', async () => {
        const nullSandbox = {
            ...sandbox(),
            type: 'null',
            run: jest
                .fn()
                .mockRejectedValue(new Error('No sandbox configured')),
        };
        const { stage } = makeStage({
            generateContextLegacy: jest
                .fn()
                .mockRejectedValue(new Error('No sandbox configured')),
        });

        const result = await run(
            stage,
            makeContext({ sandboxHandle: nullSandbox }),
        );

        expect(kinds(result)).toContain('SANDBOX_UNAVAILABLE');
        expect(kinds(result)).not.toContain('CALLGRAPH_FAILED');
    });

    it('does not record a superseded lease: the PR closed or was force-pushed', async () => {
        const { stage } = makeStage();

        const result = await run(
            stage,
            makeContext({ sandboxSuperseded: true }),
        );

        expect(kinds(result)).not.toContain('SANDBOX_UNAVAILABLE');
    });

    it('records a call graph that failed with the repository checked out', async () => {
        const { stage, graphContext } = makeStage({
            generateContextLegacy: jest
                .fn()
                .mockRejectedValue(new Error('kodus-graph exited 1')),
        });

        const result = await run(
            stage,
            makeContext({ sandboxHandle: sandbox() }),
        );

        expect(graphContext.generateContextLegacy).toHaveBeenCalled();
        expect(kinds(result)).toContain('CALLGRAPH_FAILED');
        expect(kinds(result)).not.toContain('SANDBOX_UNAVAILABLE');
    });

    it('records nothing for a full review', async () => {
        const { stage } = makeStage();

        const result = await run(
            stage,
            makeContext({ sandboxHandle: sandbox() }),
        );

        expect(kinds(result)).toEqual([]);
    });
});
