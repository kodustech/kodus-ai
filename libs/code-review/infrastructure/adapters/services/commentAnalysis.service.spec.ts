/**
 * commentAnalysis.service.spec.ts — structured-call delegation.
 *
 * Proves the comment-analysis consumer resolves the routed `codeReview` slot via
 * the permission service and then runs it through the SHARED structured executor
 * (`runStructuredReviewCall`) — instead of a hand-rolled resolveTaskModel +
 * wrapByokModel + tracedGenerateText copy. The executor owns the limiter,
 * reasoning, span, wire-schema conversion and retry (tested in its own spec), so
 * here we only assert the delegation boundary:
 *  - the org + `codeReview` task drive the slot resolution;
 *  - the CIPHERTEXT slot + trial default + telemetry metadata reach the executor;
 *  - decryption never happens here (the ciphertext slot is passed through as-is).
 *
 * Seam strategy: mock `resolveTaskSlot` (the permission-service method) and
 * `runStructuredReviewCall` (the shared executor) — no real model / network.
 */
const runStructuredReviewCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (...args: any[]) =>
        (runStructuredReviewCall as any)(...args),
}));

import { CommentAnalysisService } from './commentAnalysis.service';

describe('CommentAnalysisService — structured-call delegation', () => {
    let service: CommentAnalysisService;
    let observabilityService: { runAiSdkLLMInSpan: jest.Mock };
    let permissionValidationService: { resolveTaskSlot: jest.Mock };
    const resolveTaskSlot = jest.fn();

    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;
    // A CIPHERTEXT-bearing slot (never plaintext) — the executor decrypts, not us.
    const CIPHERTEXT_SLOT = {
        provider: 'openai',
        apiKey: 'enc-oa',
        model: 'gpt-4o',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        resolveTaskSlot.mockResolvedValue(CIPHERTEXT_SLOT);
        // Irrelevance filter returns no ids → filterComments short-circuits to []
        // after exactly one structured call.
        runStructuredReviewCall.mockResolvedValue({ ids: [] });

        observabilityService = { runAiSdkLLMInSpan: jest.fn() };
        permissionValidationService = { resolveTaskSlot };

        service = new CommentAnalysisService(
            observabilityService as any,
            permissionValidationService as any,
        );
    });

    it('resolves the codeReview slot and delegates to the shared structured executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        expect(resolveTaskSlot).toHaveBeenCalledWith(org, 'codeReview');
        expect(runStructuredReviewCall).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: CIPHERTEXT_SLOT,
                defaultModelOverride: undefined,
                observabilityService,
                spanName: expect.stringContaining(
                    `${CommentAnalysisService.name}::`,
                ),
                telemetryMetadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('hands the executor the CIPHERTEXT slot — decryption stays inside the executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        const arg = runStructuredReviewCall.mock.calls[0][0];
        expect(arg.byokConfig).toEqual(CIPHERTEXT_SLOT);
        expect(arg.byokConfig.apiKey).toBe('enc-oa'); // ciphertext, not decrypted here
    });
});
