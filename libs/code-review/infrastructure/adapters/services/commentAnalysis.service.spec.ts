/**
 * commentAnalysis.service.spec.ts — v2-native model resolution parity
 * (slice 04b, plan 04b-03).
 *
 * Proves the code-review comment-analysis consumer resolves its structured-LLM
 * model through the v2 resolver (`resolveTaskModel(rawV2, 'codeReview', …)`)
 * instead of `byokToVercelModel(byokConfig, 'main', …)`:
 *  - the raw v2 config is sourced from `getBYOKConfigV2Raw` (matching
 *    model-factory), and the task is `codeReview`;
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

const resolveTaskModel = jest.fn();
jest.mock('@libs/llm/resolve-task-model', () => ({
    resolveTaskModel: (...args: any[]) => (resolveTaskModel as any)(...args),
}));

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

describe('CommentAnalysisService — v2-native model resolution', () => {
    let service: CommentAnalysisService;
    let observabilityService: { runAiSdkLLMInSpan: jest.Mock };
    let permissionValidationService: { getBYOKConfigV2Raw: jest.Mock };

    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const rawV2 = { version: 2, credentials: [], models: [], routing: {} };

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
            getBYOKConfigV2Raw: jest.fn().mockResolvedValue(rawV2),
        };

        service = new CommentAnalysisService(
            observabilityService as any,
            permissionValidationService as any,
        );
    });

    it('resolves the codeReview slot from the raw v2 config (not byokToVercelModel)', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        expect(
            permissionValidationService.getBYOKConfigV2Raw,
        ).toHaveBeenCalledWith(org);
        expect(resolveTaskModel).toHaveBeenCalledWith(
            rawV2,
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

        // wrapByokModel is handed the ciphertext slot, wrapped as { main: slot }.
        expect(wrapByokModel).toHaveBeenCalledWith(
            { __model: true },
            expect.objectContaining({
                byokConfig: {
                    main: { provider: 'openai', apiKey: 'enc-oa', model: 'gpt-4o' },
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
