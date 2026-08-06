/**
 * commentAnalysis.service.spec.ts — native model resolution parity
 * (slice 04b, plan 04b-03).
 *
 * Proves the code-review comment-analysis consumer resolves its structured-LLM
 * model through the per-task entry point owned by the permission service
 * (`permissionService.resolveTaskModel(org, 'codeReview', …)`, matching
 * model-factory) instead of `buildModelFromSlot(byokConfig, 'main', …)`:
 *  - the org + task drive the resolution (no separate raw-config fetch);
 *  - `modelConfig.modelOverride` flows through as the default-model override
 *    (trial forces Kimi; off-BYOK still yields a model);
 *  - the observability span records the resolver's `modelName`;
 *  - secret hygiene: the CIPHERTEXT slot is what reaches `wrapByokModel`; no
 *    decrypted-key marker appears in any console log.
 *
 * Seam strategy: mock `resolveTaskModel` (proven in 04b-01) + `wrapByokModel`,
 * and drive the observability span's `exec` through the mocked `tracedGenerateText`
 * seam (NOT MockLanguageModelV4 over Output.object, which hangs).
 */

// resolveReviewAgentModel/commentAnalysis now call permissionService.resolveTaskModel;
// this mock IS that method (wired into the permission-service stub below).
const resolveTaskModel = jest.fn();

const wrapByokModel = jest.fn(() => ({ __wrapped: true }));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: (...args: any[]) => (wrapByokModel as any)(...args),
}));

const tracedGenerateText = jest.fn();
jest.mock('@libs/llm/llm-call', () => ({
    ...jest.requireActual('@libs/llm/llm-call'),
    tracedGenerateText: (...args: any[]) =>
        (tracedGenerateText as any)(...args),
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: () => ({ isEnabled: false, functionId: 'test' }),
    toAiSdkTelemetryArgs: (cfg: any) => ({ telemetry: cfg }),
}));

import { CommentAnalysisService } from './commentAnalysis.service';

describe('CommentAnalysisService — native model resolution', () => {
    let service: CommentAnalysisService;
    let observabilityService: { runAiSdkLLMInSpan: jest.Mock };
    let permissionValidationService: { resolveTaskModel: jest.Mock };

    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;

    beforeEach(() => {
        jest.clearAllMocks();

        // Resolver returns a CIPHERTEXT-bearing slot (never plaintext).
        resolveTaskModel.mockReturnValue({
            model: { __model: true },
            modelName: 'openai:gpt-4o',
            slot: { provider: 'openai', apiKey: 'enc-oa', model: 'gpt-4o' },
            verdict: null,
        });
        // Irrelevance filter returns no ids → filterComments short-circuits to
        // [] after exactly one runStructuredLLM call.
        tracedGenerateText.mockResolvedValue({
            experimental_output: { ids: [] },
        });

        observabilityService = {
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
        };
        permissionValidationService = {
            resolveTaskModel,
        };

        service = new CommentAnalysisService(
            observabilityService as any,
            permissionValidationService as any,
        );
    });

    it('resolves the codeReview slot from the raw config (not buildModelFromSlot)', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        // The per-task resolver is driven by the org + task (no raw-config fetch).
        expect(resolveTaskModel).toHaveBeenCalledWith(
            org,
            'codeReview',
            expect.objectContaining({ defaultModelOverride: undefined }),
        );
        // The observability span records the resolver's model name.
        expect(
            observabilityService.runAiSdkLLMInSpan.mock.calls[0][0].model,
        ).toBe('openai:gpt-4o');
    });

    it('keeps the slot ciphertext at the limiter boundary and never logs plaintext', async () => {
        const spies = [
            jest.spyOn(console, 'log').mockImplementation(() => {}),
            jest.spyOn(console, 'warn').mockImplementation(() => {}),
            jest.spyOn(console, 'error').mockImplementation(() => {}),
            jest.spyOn(console, 'info').mockImplementation(() => {}),
            jest.spyOn(console, 'debug').mockImplementation(() => {}),
        ];

        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        // wrapByokModel is handed the bare ciphertext slot (no `{ main }` carrier).
        expect(wrapByokModel).toHaveBeenCalledWith(
            { __model: true },
            expect.objectContaining({
                byokConfig: {
                    provider: 'openai',
                    apiKey: 'enc-oa',
                    model: 'gpt-4o',
                },
                role: 'main',
            }),
        );

        const logged = spies
            .flatMap((s) => s.mock.calls)
            .map((args) => args.map((a) => String(a)).join(' '))
            .join(' | ');
        expect(logged).not.toContain('PLAINTEXT');

        spies.forEach((s) => s.mockRestore());
    });
});
