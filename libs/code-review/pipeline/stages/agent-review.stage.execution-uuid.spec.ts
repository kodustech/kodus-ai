import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';

/**
 * Regression coverage for the `executionUuid` fallback (prod incident,
 * 2026-09-14): `context.correlationId` is a `corr_<random>_<timestamp>`
 * tracing id (id-generator.ts), never a database UUID. The old
 * `lastExecution?.uuid || context.correlationId` fallback fed that string
 * straight into `writeAgentTrace`'s `{ uuid: executionUuid }` TypeORM filter
 * whenever `lastExecution.uuid` was absent, which Postgres rejected with
 * "invalid input syntax for type uuid" on every write.
 */
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

const makeStage = (automationExecutionService: any) => {
    const reviewOrchestrator = { execute: jest.fn() };
    const stage = new AgentReviewStage(
        automationExecutionService,
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

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
});

describe('AgentReviewStage — executionUuid never falls back to correlationId', () => {
    it('writes the agent trace against {pullRequestNumber, repositoryId}, not a corr_ string, when lastExecution.uuid is absent', async () => {
        const updateCodeReview = jest.fn().mockResolvedValue(undefined);
        const automationExecutionService = {
            findLatestStageLog: jest.fn(),
            updateCodeReview,
            updateStageLog: jest.fn(),
        } as any;
        const { stage, reviewOrchestrator } = makeStage(
            automationExecutionService,
        );

        // No pipelineMetadata.lastExecution.uuid — only a correlationId, the
        // exact shape observed in production.
        const ctx = makeContext({
            correlationId: 'corr_aDSBmmECY6kD_mu1tc7oc',
            pipelineMetadata: {},
        });

        reviewOrchestrator.execute.mockImplementation(async (input: any) => {
            input.onAgentProgress?.({
                status: 'started',
                agentName: 'generalist',
                agentCategory: 'bug',
            });
            return { suggestions: [], agentResults: [], failures: [], incomplete: [], warnings: [] };
        });

        await (stage as any).executeStage(ctx);
        // writeAgentTrace is fire-and-forget (not awaited by the progress
        // callback) — flush the microtask queue so its own await resolves.
        await new Promise((resolve) => setImmediate(resolve));

        expect(updateCodeReview).toHaveBeenCalledTimes(1);
        const [filter] = updateCodeReview.mock.calls[0];
        // The correlationId must NEVER appear as (or inside) the filter's uuid.
        expect(filter).not.toEqual({ uuid: 'corr_aDSBmmECY6kD_mu1tc7oc' });
        expect(filter.uuid).toBeUndefined();
        expect(filter).toEqual({
            pullRequestNumber: 7,
            repositoryId: 'repo-1',
        });
    });

    it('still uses the real UUID when lastExecution.uuid IS present', async () => {
        const updateCodeReview = jest.fn().mockResolvedValue(undefined);
        const automationExecutionService = {
            findLatestStageLog: jest.fn(),
            updateCodeReview,
            updateStageLog: jest.fn(),
        } as any;
        const { stage, reviewOrchestrator } = makeStage(
            automationExecutionService,
        );

        const ctx = makeContext({
            correlationId: 'corr_aDSBmmECY6kD_mu1tc7oc',
            pipelineMetadata: {
                lastExecution: { uuid: '11111111-2222-3333-4444-555555555555' },
            },
        });

        reviewOrchestrator.execute.mockImplementation(async (input: any) => {
            input.onAgentProgress?.({
                status: 'started',
                agentName: 'generalist',
                agentCategory: 'bug',
            });
            return { suggestions: [], agentResults: [], failures: [], incomplete: [], warnings: [] };
        });

        await (stage as any).executeStage(ctx);
        await new Promise((resolve) => setImmediate(resolve));

        expect(updateCodeReview).toHaveBeenCalledTimes(1);
        const [filter] = updateCodeReview.mock.calls[0];
        expect(filter).toEqual({ uuid: '11111111-2222-3333-4444-555555555555' });
    });
});
