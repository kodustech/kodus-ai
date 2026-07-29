/**
 * ClassifyCliSessionCaptureUseCase — migrated-consumer parity spec (Phase 3, plan 03-09).
 *
 * Sibling of the 03-01 tracer (classify-session.use-case.spec.ts). Proves the
 * "no behavior change on the happy path" gate after migrating extractWithLLM off
 * the kodus-common BYOKPromptRunner LangChain path (CEREBRAS_GLM_47 pin) onto the
 * AI SDK path (runStructuredReviewCall, byokConfig: undefined → managed default).
 * Parity is on the parsed decisions[] mapping: a fixed { decisions: [...] } result,
 * returned through the REAL runStructuredReviewCall (real schema conversion + model
 * resolution + span), maps byte-for-byte to the same CliSessionClassifiedDecision[]
 * the pre-migration mapping produced.
 *
 * NOTE: this mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * uses) rather than driving generateText+Output.object against a MockLanguageModelV4 —
 * that structured-output path hangs against an offline model double. Parity here
 * targets the decisions[] mapping, which is exactly the migration's behavior-change risk.
 */
const MODEL_DECISIONS = {
    decisions: [
        {
            type: 'architectural_decision',
            origin: 'human',
            decision: 'Use event sourcing for the audit log',
            rationale: 'Full auditability of every state change',
            confidence: 0.9,
            evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
        },
        {
            type: 'tooling',
            decision: 'Adopt pnpm as the package manager',
            confidence: 0.4,
        },
    ],
};

// Model builders return sentinels — no real model/network is touched.
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

import { ClassifyCliSessionCaptureUseCase } from './classify-cli-session-capture.use-case';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const cliSessionCaptureRepository = {} as any;

function buildUseCase(): ClassifyCliSessionCaptureUseCase {
    return new ClassifyCliSessionCaptureUseCase(
        cliSessionCaptureRepository,
        observabilityService,
    );
}

const capture = {
    organizationId: 'org-123',
    summary: 'Designed the audit log',
    signals: {
        prompt: 'Design the audit log',
        assistantMessage: 'I chose event sourcing.',
        modifiedFiles: ['src/audit/store.ts', 'src/audit/replay.ts'],
        toolUses: [{ tool: 'Edit', filePath: 'src/audit/store.ts' }],
    },
};

describe('ClassifyCliSessionCaptureUseCase.extractWithLLM — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
        mockGenerate.mockResolvedValue({ experimental_output: MODEL_DECISIONS });
    });

    it('maps the model decisions[] byte-for-byte to CliSessionClassifiedDecision[]', async () => {
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(capture);

        expect(decisions).toEqual([
            {
                type: 'architectural_decision',
                origin: 'human',
                decision: 'Use event sourcing for the audit log',
                rationale: 'Full auditability of every state change',
                confidence: 0.9,
                evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
                // 0.9 >= 0.7 and architectural_decision is auto-promotable.
                autoPromoteCandidate: true,
            },
            {
                type: 'tooling',
                origin: undefined,
                decision: 'Adopt pnpm as the package manager',
                rationale: undefined,
                confidence: 0.4,
                evidence: [],
                // 0.4 < 0.7 → not a candidate.
                autoPromoteCandidate: false,
            },
        ]);
    });

    it('routes through exactly one AI SDK span path (runAiSdkLLMInSpan), no LangChain wrapper', async () => {
        const useCase = buildUseCase();

        await (useCase as any).extractWithLLM(capture);

        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('empty decisions → empty mapping (no throw)', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: { decisions: [] },
        });
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(capture);

        expect(decisions).toEqual([]);
    });
});
