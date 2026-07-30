import { PromptContextEngineService } from '@libs/ai-engine/infrastructure/adapters/services/prompt/promptContextEngine.service';
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

describe('buildSearchPatterns', () => {
    const build = (ref: any) =>
        (PromptContextEngineService.prototype as any).buildSearchPatterns.call(
            Object.create(PromptContextEngineService.prototype),
            ref,
        );

    it('extensionless names also try the .md variant (README → README.md)', () => {
        const patterns = build({ fileName: 'README' });
        expect(patterns).toContain('**/README.md');
        expect(patterns).toContain('**/readme.md');
    });

    it('names with extension are untouched', () => {
        const patterns = build({ fileName: 'docs/setup.md' });
        expect(
            patterns.filter((p: string) => p.endsWith('.md.md')),
        ).toHaveLength(0);
    });
});
