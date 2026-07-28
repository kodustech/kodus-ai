/**
 * Parity spec for the collectCrossFileContexts migration onto
 * runStructuredReviewCall (both call sites: planner ~424 and sufficiency ~1185).
 *
 * Same approach as crossFileAnalysis.service.spec.ts / structured-review-call.spec.ts:
 * mock the low-level model builders and the `tracedGenerateText` generate seam,
 * and let the REAL runStructuredReviewCall run through the private methods.
 * Driving the structured path over MockLanguageModelV4 HANGS (Phase 0 + 03-01),
 * so we assert against a mocked structured result at the generate seam.
 */

// --- Seam mocks (hoisted before the service graph loads) ---------------------
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn((_byokConfig: any, role: string) => ({
        __model: role,
    })),
    getModelName: jest.fn(() => 'test-model'),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { CollectCrossFileContextsService } from './collectCrossFileContexts.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const tokenChunkingService = {} as any;
const configService = {} as any;
const codebaseSearchService = {} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const byokConfig = { main: { provider: 'openai', model: 'gpt-4o' } } as any;

const organizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
} as any;

describe('CollectCrossFileContextsService — runStructuredReviewCall parity', () => {
    let service: CollectCrossFileContextsService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new CollectCrossFileContextsService(
            observabilityService,
            tokenChunkingService,
            configService,
            codebaseSearchService,
        );
    });

    it('planner site: runs the structured call on the BYOK main model with the planner prompt as system + fixed user, returning queries', async () => {
        const queries = [
            {
                symbolName: 'fetchUser',
                pattern: 'fetchUser',
                riskLevel: 'high',
                rationale: 'signature changed',
                sourceFile: 'src/user.ts',
            },
        ];
        mockGenerate.mockResolvedValueOnce(ok({ queries }));

        const result = await (service as any).buildPlannerPromptRunner(
            '### src/user.ts\n+ function fetchUser() {}',
            ['src/user.ts'],
            'en-US',
            byokConfig,
            organizationAndTeamData,
            123,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        const callArgs = mockGenerate.mock.calls[0][0];
        expect(callArgs.model).toEqual({ __model: 'main' });
        expect(callArgs.system).toContain('code analysis planner');
        expect(callArgs.prompt).toBe(
            'Analyze the diff and generate search queries. Return the response in the specified JSON format.',
        );

        expect(result).toEqual(queries);
    });

    it('planner site: empty/absent structured result yields []', async () => {
        mockGenerate.mockResolvedValueOnce(ok({}));

        const result = await (service as any).buildPlannerPromptRunner(
            '### src/user.ts\n+ x',
            ['src/user.ts'],
            'en-US',
            byokConfig,
            organizationAndTeamData,
            123,
        );

        expect(result).toEqual([]);
    });

    it('sufficiency site: runs the structured call on the BYOK main model with the sufficiency prompt as system + fixed user, returning the verdict', async () => {
        const verdict = {
            isSufficient: false,
            gaps: ['missing caller of fetchUser'],
            additionalQueries: [],
        };
        mockGenerate.mockResolvedValueOnce(ok(verdict));

        const plannerQueries = [
            {
                symbolName: 'fetchUser',
                pattern: 'fetchUser',
                riskLevel: 'high',
                rationale: 'signature changed',
                sourceFile: 'src/user.ts',
            },
        ] as any;

        const result = await (service as any).evaluateSufficiency(
            [{ filename: 'src/user.ts', patchWithLinesStr: '+ x' }] as any,
            plannerQueries,
            [], // currentContexts
            new Map<string, boolean>([['fetchUser', false]]),
            'en-US',
            byokConfig,
            organizationAndTeamData,
            123,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        const callArgs = mockGenerate.mock.calls[0][0];
        expect(callArgs.model).toEqual({ __model: 'main' });
        expect(callArgs.system).toContain('code review context evaluator');
        expect(callArgs.prompt).toBe(
            'Evaluate whether the collected cross-file context is sufficient. Return the response in the specified JSON format.',
        );

        expect(result).toEqual(verdict);
    });

    it('sufficiency site: swallows a call failure and returns null (unchanged catch parity)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('provider down'));

        const result = await (service as any).evaluateSufficiency(
            [{ filename: 'src/user.ts', patchWithLinesStr: '+ x' }] as any,
            [] as any,
            [],
            new Map<string, boolean>(),
            'en-US',
            byokConfig,
            organizationAndTeamData,
            123,
        );

        expect(result).toBeNull();
    });
});
