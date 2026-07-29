/**
 * PullRequestClassifierService.classifyBatch — migration parity spec (Phase 3, plan 03-09).
 *
 * Proves the batch classifier's parsed OUTPUT SHAPE is unchanged after migrating
 * off the kodus-common LangChain PromptRunner path (GEMINI_3_1_FLASH_LITE_PREVIEW
 * pin via `.setProviders`) onto the AI SDK path (runStructuredReviewCall, byokConfig:
 * undefined → managed default). The model CONSOLIDATION is deliberate (RESEARCH
 * Pattern 1) and does not touch the parsed contract: a fixed { classifications: [...] }
 * result maps byte-for-byte to the same Map<string, PRType> the pre-migration code
 * produced, including the defensive id-trim and the PR_TYPES membership filter.
 *
 * NOTE: mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts uses)
 * rather than driving generateText+Output.object against a MockLanguageModelV4 —
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

import { PullRequestClassifierService } from './pull-request-classifier.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

function buildService(): PullRequestClassifierService {
    return new PullRequestClassifierService(
        {} as any, // DataSource — unused by classifyBatch
        {} as any, // pullRequestsModel — unused by classifyBatch
        observabilityService,
    );
}

const batch = [
    { id: 'pr-1', organizationId: 'org-1', title: 'fix: null deref in parser' },
    { id: 'pr-2', organizationId: 'org-1', title: 'feat: add BYOK routing' },
    { id: 'pr-3', organizationId: 'org-1', title: 'chore: bump deps' },
];

describe('PullRequestClassifierService.classifyBatch — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    it('maps classifications[] to the same Map<string, PRType>, trimming ids and dropping unknown types', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: {
                classifications: [
                    // Trailing whitespace on the echoed id — must be trimmed.
                    { pullRequestId: 'pr-1 ', type: 'Bug Fix' },
                    { pullRequestId: 'pr-2', type: 'Feature' },
                    // Unknown type not in PR_TYPES — must be dropped.
                    { pullRequestId: 'pr-3', type: 'Chore' },
                ],
            },
        });

        const service = buildService();
        const result: Map<string, string> = await (
            service as any
        ).classifyBatch(batch);

        expect(result instanceof Map).toBe(true);
        expect([...result.entries()]).toEqual([
            ['pr-1', 'Bug Fix'],
            ['pr-2', 'Feature'],
        ]);
        // pr-3 dropped (type not in PR_TYPES).
        expect(result.has('pr-3')).toBe(false);
    });

    it('routes through exactly one AI SDK span path (runAiSdkLLMInSpan), no LangChain wrapper', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: { classifications: [] },
        });

        const service = buildService();
        const result = await (service as any).classifyBatch(batch);

        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect([...result.entries()]).toEqual([]);
    });
});
