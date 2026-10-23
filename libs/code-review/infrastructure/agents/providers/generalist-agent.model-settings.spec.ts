/**
 * The generalist's finder runs with its model family's step cap and synthesis
 * rescue (finder-model-profile.ts), and the agent loop receives them.
 */
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/model-factory',
    () => ({ resolveReviewAgentModel: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter',
    () => ({ runAgentLoopViaCore: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/review-observability',
    () => ({
        runAgentWithTrace: jest.fn((_m: any, _i: any, fn: () => any) => fn()),
    }),
);

import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';

import { GeneralistAgentProvider } from './generalist-agent.provider';

const resolveModelMock = resolveReviewAgentModel as jest.Mock;
const runLoopMock = runAgentLoopViaCore as jest.Mock;

function input(over: Record<string, unknown> = {}): any {
    return {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        changedFiles: [
            {
                filename: 'src/orders.ts',
                patch: '@@ -1,1 +1,2 @@\n+total += item.price;',
                patchWithLinesStr: '@@ -1,1 +1,2 @@\n+total += item.price;',
            },
        ],
        prNumber: 7,
        repositoryFullName: 'example/shop',
        languageResultPrompt: 'en-US',
        remoteCommands: undefined,
        reviewMode: 'normal',
        maxSteps: 34,
        ...over,
    };
}

function loopResult(): any {
    return {
        findings: { reasoning: 'r', suggestions: [] },
        text: '',
        steps: 3,
        toolCalls: [],
        finishReason: 'stop',
        source: 'json-parse',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage: { covered: 1, total: 1 },
        verification: null,
        anomalies: {},
        warnings: [],
    };
}

async function loopParamsFor(modelName: string, over: Record<string, unknown> = {}) {
    resolveModelMock.mockResolvedValue({
        byokConfig: { provider: 'openai', model: modelName },
        main: { role: 'main', modelName, maxInputTokens: 1_000_000 },
    });
    await new GeneralistAgentProvider({} as any, {} as any).execute(input(over));
    const [params] = runLoopMock.mock.calls[0];
    return { maxSteps: params.maxSteps, skipSynthesisRescue: params.skipSynthesisRescue };
}

beforeEach(() => {
    jest.clearAllMocks();
    runLoopMock.mockResolvedValue(loopResult());
});

describe('GeneralistAgentProvider — settings by model', () => {
    it.each([
        ['claude-opus-5-5', 12, true],
        ['gpt-6-sol', 12, true],
        ['muse-spark-1.3', 12, false],
        ['claude-sonnet-5-5', 12, false],
        ['deepseek-v4-flash', 34, false],
        ['kimi-k2.7-code', 34, false],
        ['an-unmapped-model', 12, true],
    ])('runs %s with %s steps (skip rescue: %s)', async (model, maxSteps, skipSynthesisRescue) => {
        expect(await loopParamsFor(model)).toEqual({ maxSteps, skipSynthesisRescue });
    });

    it('keeps the budget of a fast review', async () => {
        expect(await loopParamsFor('claude-opus-5-5', { reviewMode: 'fast', maxSteps: 4 })).toEqual({
            maxSteps: 4,
            skipSynthesisRescue: undefined,
        });
    });
});
