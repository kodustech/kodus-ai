/**
 * SuggestionLLMValidator — migration parity spec (Phase 3, plan 03-09).
 *
 * Proves the primary validation verdict is unchanged after migrating both call
 * sites off the kodus-common LangChain PromptRunner path (GROQ_GPT_OSS_120B /
 * GEMINI_2_5_FLASH pins via `.setProviders` inside runLLMInSpan) onto the AI SDK
 * path (runStructuredReviewCall, byokConfig: undefined → managed default). The
 * model CONSOLIDATION is deliberate (RESEARCH Pattern 1); the parsed verdict is
 * what callers depend on, and it maps byte-for-byte: a fixed structured result
 * flows straight back out of validateWithLLM / checkSuggestionSimplicity. The
 * outer runLLMInSpan double-wrap is gone (Q4) — exactly one AI SDK span path.
 *
 * NOTE: mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * uses) rather than driving generateText+Output.object against a MockLanguageModelV4 —
 * that structured-output path hangs against an offline model double.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __model: 'managed-default' })),
    getModelName: jest.fn(() => 'managed-default'),
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

import { SuggestionLLMValidator } from './suggestionLLMValidator.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

function buildValidator(): SuggestionLLMValidator {
    return new SuggestionLLMValidator(observabilityService);
}

const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

const payload = {
    code: 'const x: number = foo();',
    filePath: 'src/x.ts',
    language: 'typescript',
    diff: '+const x: number = foo();',
};

describe('SuggestionLLMValidator.validateWithLLM — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    it('returns the parsed validation verdict unchanged', async () => {
        const verdict = {
            isValid: false,
            issues: [{ lineNumber: 1, message: 'foo is not defined' }],
        };
        mockGenerate.mockResolvedValue({ experimental_output: verdict });

        const validator = buildValidator();
        const result = await validator.validateWithLLM(payload, orgAndTeam, 42);

        expect(result).toEqual(verdict);
        // Exactly one AI SDK span path, no LangChain double-wrap.
        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('returns null when the underlying call throws (unchanged error contract)', async () => {
        mockGenerate.mockRejectedValue(new Error('provider down'));

        const validator = buildValidator();
        const result = await validator.validateWithLLM(payload, orgAndTeam, 42);

        expect(result).toBeNull();
    });
});

describe('SuggestionLLMValidator.checkSuggestionSimplicity — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    it('returns the parsed simplicity verdict unchanged', async () => {
        const verdict = { isSimple: true, reason: 'local one-line fix' };
        mockGenerate.mockResolvedValue({ experimental_output: verdict });

        const validator = buildValidator();
        const result = await validator.checkSuggestionSimplicity(
            orgAndTeam,
            42,
            {
                id: 'sug-1',
                language: 'typescript',
                existingCode: 'let a = 1',
                improvedCode: 'const a = 1',
            },
        );

        expect(result).toEqual(verdict);
        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
    });

    it('falls back to { isSimple: false } on error (unchanged contract)', async () => {
        mockGenerate.mockRejectedValue(new Error('provider down'));

        const validator = buildValidator();
        const result = await validator.checkSuggestionSimplicity(
            orgAndTeam,
            42,
            { id: 'sug-1' },
        );

        expect(result).toEqual({
            isSimple: false,
            reason: 'Error during check',
        });
    });
});
