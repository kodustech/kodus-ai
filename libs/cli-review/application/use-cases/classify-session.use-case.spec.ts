/**
 * ClassifySessionUseCase — migrated-consumer parity spec (Phase 3, plan 03-01 — tracer).
 *
 * Proves the "no behavior change on the happy path" gate after migrating
 * extractWithLLM off the kodus-common BYOKPromptRunner LangChain path onto the AI
 * SDK path (runStructuredReviewCall). Parity is on the parsed decisions[] mapping:
 * a fixed { decisions: [...] } result, returned through the REAL runStructuredReviewCall
 * (real schema conversion + model resolution + span), maps byte-for-byte to the same
 * CliSessionClassifiedDecision[] the pre-migration mapping produced.
 *
 * NOTE: this mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * uses) rather than driving generateText+Output.object against a MockLanguageModelV4 —
 * that structured-output path does not resolve against an offline model double. The
 * real MockLanguageModelV4 → SDK → normalize boundary (D-05) is proven in the sibling
 * conformance harness (openai.module.spec.ts), so parity here targets the decisions[]
 * mapping, which is exactly the migration's behavior-change risk.
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
    byokToVercelModel: jest.fn(() => ({ __model: 'managed-default' })),
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

import { ClassifySessionUseCase } from './classify-session.use-case';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const sessionEventRepository = {} as any;

function buildUseCase(): ClassifySessionUseCase {
    return new ClassifySessionUseCase(
        sessionEventRepository,
        observabilityService,
    );
}

const aggregated = {
    agentType: 'claude-code',
    gitRemote: 'git@github.com:kodus/example.git',
    turns: [
        {
            prompt: 'Design the audit log',
            response: 'I chose event sourcing.',
            toolCalls: ['Edit'],
            filesModified: ['src/audit/store.ts'],
        },
    ],
    prompts: ['Design the audit log'],
    responses: ['I chose event sourcing.'],
    toolCalls: ['Edit'],
    filesModified: ['src/audit/store.ts', 'src/audit/replay.ts'],
    filesRead: [],
    commands: [],
    subagents: [],
};

describe('ClassifySessionUseCase.extractWithLLM — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
        mockGenerate.mockResolvedValue({ experimental_output: MODEL_DECISIONS });
    });

    it('maps the model decisions[] byte-for-byte to CliSessionClassifiedDecision[]', async () => {
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(
            aggregated,
            'org-123',
        );

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

        await (useCase as any).extractWithLLM(aggregated, 'org-123');

        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('empty decisions → empty mapping (no throw)', async () => {
        mockGenerate.mockResolvedValue({ experimental_output: { decisions: [] } });
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(
            aggregated,
            'org-123',
        );

        expect(decisions).toEqual([]);
    });
});
