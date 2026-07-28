/**
 * LLMAnalysisService — migrated-consumer parity spec (Phase 3, plan 03-06).
 *
 * llmAnalysis is the core code-review analyzer and sits on the customer review
 * hot path, so this parity spec is mandatory (not a grep-only gate). It proves
 * the "no behavior change on the happy path" contract after migrating the
 * structured call-sites off the kodus-common BYOKPromptRunner LangChain path
 * onto the AI SDK path (runStructuredReviewCall).
 *
 * The primary analysis call is `analyzeCodeWithAI_v2` (the standard review path
 * — `codeAnalysisOrchestrator` calls `standardLLMAnalysisService.analyzeCodeWithAI_v2`).
 * Parity is on the parsed `codeSuggestions` mapping: a fixed structured result,
 * returned through the REAL runStructuredReviewCall (real model resolution + span),
 * maps byte-for-byte to the same AIAnalysisResult the pre-migration mapping produced,
 * and the model is invoked exactly once (one span path — no leftover runLLMInSpan
 * double-count, Q4).
 *
 * NOTE: this mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * and the 03-01 tracer parity spec use) rather than driving generateText+Output.object
 * against a MockLanguageModelV4 — that structured-output path HANGS against an offline
 * model double (Phase 0 + 03-01). Parity here targets the codeSuggestions mapping,
 * which is exactly the migration's behavior-change risk.
 */
const MODEL_SUGGESTIONS = {
    codeSuggestions: [
        {
            id: 'sug-1',
            relevantFile: 'src/payments/charge.ts',
            language: 'typescript',
            suggestionContent: 'Guard against a null customer before charging.',
            existingCode: 'charge(customer.id)',
            improvedCode: 'if (customer) charge(customer.id)',
            oneSentenceSummary: 'Null-guard the customer',
            relevantLinesStart: 42,
            relevantLinesEnd: 42,
            label: 'potential_error',
            severity: 'high',
        },
        {
            id: 'sug-2',
            relevantFile: 'src/payments/charge.ts',
            language: 'typescript',
            suggestionContent: 'Extract the retry constant.',
            improvedCode: 'const MAX_RETRIES = 3;',
            label: 'maintainability',
        },
    ],
};

// Model builders return sentinels — no real model/network is touched.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(() => ({ __model: 'byok-main' })),
    getModelName: jest.fn(() => 'byok-main'),
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

import { LLMAnalysisService } from './llmAnalysis.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
// runLLMInSpan is the OLD LangChain wrapper; it must never be touched (Q4).
const observability = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    runLLMInSpan: jest.fn(),
} as any;

const safeguardPipeline = {} as any;

function buildService(): LLMAnalysisService {
    return new LLMAnalysisService(observability, safeguardPipeline);
}

const organizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
} as any;

const fileContext = {
    file: {
        filename: 'src/payments/charge.ts',
        fileContent: 'export function charge() {}',
    },
    patchWithLinesStr: '42 + charge(customer.id)',
    relevantContent: 'export function charge() {}',
    hasRelevantContent: true,
} as any;

const context = {
    pullRequest: { number: 77, body: 'Add charge retries' },
    repository: { language: 'typescript' },
    codeReviewConfig: {
        suggestionControl: {},
        reviewOptions: {},
        languageResultPrompt: 'en-US',
    },
    organizationAndTeamData,
} as any;

const byokConfig = {
    main: { provider: 'openai', model: 'gpt-4o' },
} as any;

describe('LLMAnalysisService.analyzeCodeWithAI_v2 — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observability.runAiSdkLLMInSpan.mockClear();
        observability.runLLMInSpan.mockClear();
        mockGenerate.mockResolvedValue({ experimental_output: MODEL_SUGGESTIONS });
    });

    it('maps the model codeSuggestions[] byte-for-byte into AIAnalysisResult', async () => {
        const service = buildService();

        const result = await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            byokConfig,
        );

        expect(result).toEqual({
            codeSuggestions: MODEL_SUGGESTIONS.codeSuggestions,
            codeReviewModelUsed: {
                // byokConfig.main.provider wins over the default provider.
                generateSuggestions: 'openai',
            },
        });
    });

    it('routes through exactly one AI SDK span (runAiSdkLLMInSpan), no LangChain runLLMInSpan wrapper (Q4)', async () => {
        const service = buildService();

        await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            byokConfig,
        );

        expect(observability.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        // No leftover LangChain span path — single-span billing.
        expect(observability.runLLMInSpan).not.toHaveBeenCalled();
    });

    it('falls back to the default provider label when no BYOK provider is set', async () => {
        const service = buildService();

        const result = await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            {} as any,
        );

        // GEMINI_2_5_PRO enum value — the pre-migration default label.
        expect(result?.codeReviewModelUsed?.generateSuggestions).toBe(
            'google:gemini-2.5-pro',
        );
        expect(result?.codeSuggestions).toEqual(
            MODEL_SUGGESTIONS.codeSuggestions,
        );
    });
});
