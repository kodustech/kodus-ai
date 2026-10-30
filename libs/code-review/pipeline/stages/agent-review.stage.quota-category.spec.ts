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
 * #2191 — the pipeline observer concludes the check from the LLM error
 * category of the recorded errors, so the stage has to put it there:
 * `metadata.category` is the agent's category, not the error's.
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

describe('AgentReviewStage — LLM error category on recorded failures (#2191)', () => {
    it('records the classified error category of a failed core agent', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    error: Object.assign(new Error('Payment Required'), {
                        status: 402,
                    }),
                },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(error?.severity).toBe('critical');
        expect(error?.metadata?.category).toBe('generalist');
        expect(error?.metadata?.errorCategory).toBe('QUOTA_EXCEEDED');
    });

    it('records UNKNOWN for a failure the classifier does not map', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                {
                    agentName: 'bug',
                    category: 'bug',
                    error: new Error('something odd'),
                },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:bug',
        );
        expect(error?.metadata?.errorCategory).toBe('UNKNOWN');
    });

    it.each([
        ['the org brought its own key', { credentialId: 'cred-1' }, true],
        ['the Kodus-managed key served the run', {}, false],
    ])('records whether %s', async (_label, slot, orgOwnedKey) => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    error: Object.assign(new Error('Payment Required'), {
                        status: 402,
                    }),
                },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(
            stage,
            makeContext({
                codeReviewConfig: {
                    reviewOptions: {},
                    resolvedModelSlot: {
                        provider: 'openai',
                        model: 'gpt-4o-mini',
                        ...slot,
                    },
                },
            }),
        );

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(error?.metadata?.orgOwnedKey).toBe(orgOwnedKey);
    });
});
