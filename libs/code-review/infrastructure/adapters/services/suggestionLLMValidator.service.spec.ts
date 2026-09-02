/**
 * SuggestionLLMValidator — migration parity spec (Phase 3, plan 03-09).
 *
 * Proves the primary validation verdict is unchanged after migrating both call
 * sites off the legacy LangChain PromptRunner path (GROQ_GPT_OSS_120B /
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
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
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
import { setLlmObservability } from '@libs/llm/llm-observability';
import { LLM } from '@libs/llm/llm';
import {
    prompt_validateCodeSemantics,
    validateCodeSemanticsSchema,
} from '@libs/common/utils/prompts/validateCodeSemantics';
import {
    checkSuggestionSimplicitySchema,
    prompt_checkSuggestionSimplicity_system,
    prompt_checkSuggestionSimplicity_user,
} from '@libs/common/utils/prompts/checkSuggestionSimplicity';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

function buildValidator(): SuggestionLLMValidator {
    // LLM.run records its span through the observability port; register the
    // test's mock so the executor's span path hits it.
    setLlmObservability(observabilityService);
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

/**
 * Input-assembly contract: everything BETWEEN the payload and the model.
 * The parity block above proves the parsed verdict flows back out; it does not
 * prove the request is built correctly. A regression in the prompt threading
 * (wrong payload field, dropped diff, a `||` default silently changed, the
 * managed-default `byokConfig: undefined` accidentally pinned to a slot) leaves
 * the verdict shape intact while sending the model the wrong question — exactly
 * the class of bug the output-only tests can't see. We spy on LLM.run directly
 * (the boundary this service owns) and assert the exact args; the spy is
 * restored so the parity block keeps exercising the real LLM.run span path.
 */
describe('SuggestionLLMValidator — LLM.run input contract', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        runSpy = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ isValid: true, issues: [] } as any);
    });

    afterEach(() => {
        runSpy.mockRestore();
    });

    describe('validateWithLLM', () => {
        it('builds the request from the payload and threads org/pr into attrs', async () => {
            const validator = buildValidator();
            await validator.validateWithLLM(payload, orgAndTeam, 42);

            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(validateCodeSemanticsSchema);
            expect(arg.system).toBe('');
            // toBe against the real (pure) builder proves every payload field —
            // code, filePath, language, diff — was threaded verbatim.
            expect(arg.user).toBe(prompt_validateCodeSemantics(payload));
            expect(arg.runName).toBe('SuggestionLLMValidator::validateWithLLM');
            expect(arg.organizationId).toBe('org-1');
            expect(arg.attrs).toEqual({
                prNumber: 42,
                filePath: 'src/x.ts',
                teamId: 'team-1',
            });
            // Managed-default routing: never a pinned slot here.
            expect(arg.byokConfig).toBeUndefined();
        });

        it('tolerates an absent org/team (optional-chaining, no throw)', async () => {
            const validator = buildValidator();
            const result = await validator.validateWithLLM(
                payload,
                undefined as any,
                7,
            );

            // The `?.` on organizationAndTeamData must survive an undefined arg:
            // organizationId/teamId resolve to undefined instead of throwing.
            const arg = runSpy.mock.calls[0][0];
            expect(arg.organizationId).toBeUndefined();
            expect(arg.attrs).toEqual({
                prNumber: 7,
                filePath: 'src/x.ts',
                teamId: undefined,
            });
            expect(result).toEqual({ isValid: true, issues: [] });
        });
    });

    describe('checkSuggestionSimplicity', () => {
        beforeEach(() => {
            runSpy.mockResolvedValue({ isSimple: true, reason: 'ok' } as any);
        });

        it('builds system+user from the suggestion and threads attrs', async () => {
            const validator = buildValidator();
            await validator.checkSuggestionSimplicity(orgAndTeam, 99, {
                id: 'sug-9',
                language: 'python',
                existingCode: 'a=1',
                improvedCode: 'a = 1',
            });

            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(checkSuggestionSimplicitySchema);
            expect(arg.system).toBe(prompt_checkSuggestionSimplicity_system());
            expect(arg.user).toBe(
                prompt_checkSuggestionSimplicity_user({
                    language: 'python',
                    existingCode: 'a=1',
                    improvedCode: 'a = 1',
                }),
            );
            expect(arg.runName).toBe(
                'SuggestionLLMValidator::checkSuggestionSimplicity',
            );
            expect(arg.organizationId).toBe('org-1');
            expect(arg.attrs).toEqual({
                prNumber: 99,
                teamId: 'team-1',
                suggestionId: 'sug-9',
            });
            expect(arg.byokConfig).toBeUndefined();
        });

        it('applies the language/code defaults when the suggestion omits them', async () => {
            const validator = buildValidator();
            await validator.checkSuggestionSimplicity(orgAndTeam, 1, {
                id: 'sug-empty',
            });

            // The `|| 'text'` and `|| ''` fallbacks must reach the prompt — a
            // mutated default would send the model `undefined` fences.
            const arg = runSpy.mock.calls[0][0];
            expect(arg.user).toBe(
                prompt_checkSuggestionSimplicity_user({
                    language: 'text',
                    existingCode: '',
                    improvedCode: '',
                }),
            );
        });

        it('returns the no-result fallback when LLM.run resolves nullish', async () => {
            runSpy.mockResolvedValue(null as any);

            const validator = buildValidator();
            const result = await validator.checkSuggestionSimplicity(
                orgAndTeam,
                1,
                { id: 'sug-1' },
            );

            expect(result).toEqual({
                isSimple: false,
                reason: 'No result from LLM',
            });
        });
    });
});
