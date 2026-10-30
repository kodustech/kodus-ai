import { ContextReferenceService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference.service';

describe('computeProcessingStatus', () => {
    const compute = (reqs: any) =>
        (ContextReferenceService.prototype as any).computeProcessingStatus.call(
            Object.create(ContextReferenceService.prototype),
            reqs,
        );

    it('empty revision (clean re-detection) is COMPLETED, not pending', () => {
        // 'pending' left an eternal "Processing references…" spinner on any
        // rule whose broken references were fixed (observed live on the
        // manual validation env).
        expect(compute([])).toBe('completed');
        expect(compute(undefined)).toBe('completed');
    });

    it('errors → failed; draft → processing; all active → completed', () => {
        expect(
            compute([{ status: 'draft', metadata: { syncErrors: [{}] } }]),
        ).toBe('failed');
        expect(compute([{ status: 'draft', metadata: {} }])).toBe('processing');
        expect(compute([{ status: 'active', metadata: {} }])).toBe('completed');
    });
});
