/**
 * Parity spec for the runStructuredReviewCall migration (03-05).
 *
 * We mock the model/network seam (tracedGenerateText) exactly like
 * structured-review-call.spec.ts so the REAL runStructuredReviewCall runs
 * (schema conversion + span plumbing) but hits no provider. Driving over
 * MockLanguageModelV4 HANGS on the structured path (Phase 0 + 03-01), so we
 * stop at the tracedGenerateText boundary and return a canned structured
 * object. The assertions prove the migrated call-sites map the structured
 * output onto the same downstream shapes the STRING parser produced.
 */
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
    toAiSdkTelemetryArgs: jest.fn(() => ({
        telemetry: { isEnabled: false },
    })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { KodyRulesPrLevelAnalysisService } from './kodyRulesPrLevelAnalysis.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
const PR_NUMBER = 42;

describe('KodyRulesPrLevelAnalysisService — runStructuredReviewCall parity', () => {
    let service: KodyRulesPrLevelAnalysisService;

    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();

        service = new KodyRulesPrLevelAnalysisService(
            {} as any, // kodyRulesService
            {} as any, // tokenChunkingService
            {} as any, // promptRunnerService (DI-only, unused after migration)
            observabilityService,
            {} as any, // externalReferenceLoaderService
        );
    });

    const buildContext = (): any => ({
        pullRequest: {
            title: 'Add feature',
            body: 'desc',
            user: { login: 'octocat' },
            tags: [],
            stats: {
                total_additions: 1,
                total_deletions: 0,
                total_files: 1,
                total_lines_changed: 1,
            },
        },
        codeReviewConfig: { byokConfig: undefined, kodyMemoryRules: [] },
    });

    it('maps a structured analyzer result to violated rules (analyzer site)', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                rules: [
                    {
                        ruleId: 'rule-1',
                        violations: [
                            {
                                violatedFileSha: ['sha1'],
                                relatedFileSha: ['sha2'],
                                oneSentenceSummary: 'Do the thing',
                                suggestionContent:
                                    'Fix it. Kody Rule violation: rule-1',
                            },
                        ],
                    },
                ],
            }),
        );

        const kodyRules = [
            { uuid: 'rule-1', title: 'Rule One', rule: 'do it' },
        ] as any;

        const result = await (service as any).processChunk(
            buildContext(),
            [{ filename: 'a.ts', patch: '@@', status: 'modified' }],
            kodyRules,
            'en-US',
            'gemini-2.5-pro',
            0,
            PR_NUMBER,
            orgData,
            undefined,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].uuid).toBe('rule-1');
        expect(result[0].violations[0].suggestionContent).toContain('rule-1');
        expect(result[0].violations[0].oneSentenceSummary).toBe('Do the thing');
    });

    it('returns null when the analyzer reports no violations', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ rules: [] }));

        const result = await (service as any).processChunk(
            buildContext(),
            [{ filename: 'a.ts', patch: '@@', status: 'modified' }],
            [{ uuid: 'rule-1', title: 'Rule One', rule: 'do it' }] as any,
            'en-US',
            'gemini-2.5-pro',
            0,
            PR_NUMBER,
            orgData,
            undefined,
        );

        expect(result).toBeNull();
    });

    it('consolidates duplicate suggestions via the structured grouper (grouper site)', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                ruleId: 'rule-1',
                violations: [
                    {
                        violatedFileSha: ['sha1', 'sha2'],
                        relatedFileSha: [],
                        oneSentenceSummary: 'Grouped summary',
                        suggestionContent: 'Grouped content',
                    },
                ],
            }),
        );

        const rule = { uuid: 'rule-1', title: 'Rule One', rule: 'desc' } as any;
        const duplicated = [
            {
                id: 'a',
                suggestionContent: 'c1',
                oneSentenceSummary: 's1',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                files: { violatedFileSha: ['sha1'], relatedFileSha: [] },
            },
            {
                id: 'b',
                suggestionContent: 'c2',
                oneSentenceSummary: 's2',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                files: { violatedFileSha: ['sha2'], relatedFileSha: [] },
            },
        ] as any;

        const grouped = await (service as any).processRuleGrouping(
            rule,
            duplicated,
            'en-US',
            orgData,
            PR_NUMBER,
            undefined,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(grouped.suggestionContent).toBe('Grouped content');
        expect(grouped.oneSentenceSummary).toBe('Grouped summary');
        expect(grouped.files.violatedFileSha).toEqual(['sha1', 'sha2']);
    });
});
