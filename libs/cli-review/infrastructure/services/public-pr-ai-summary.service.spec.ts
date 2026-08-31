import { LLM } from '@libs/llm/llm';
import { PublicPrAiSummaryService } from './public-pr-ai-summary.service';

/**
 * Thin wrapper over the model, but the two contracts that matter for a PUBLIC
 * demo page are worth pinning: an empty/whitespace generation collapses to
 * undefined (so the UI shows nothing rather than a blank box), and any model
 * error degrades to undefined instead of crashing the page.
 */
describe('PublicPrAiSummaryService.generate — trim & fail-safe', () => {
    const svc = new PublicPrAiSummaryService();
    const pr = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        title: 't',
        baseRef: 'main',
        headRef: 'x',
    } as any;
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns the trimmed summary text', async () => {
        runSpy.mockResolvedValue('  a summary  ');
        expect(await svc.generate(pr, 'diff')).toBe('a summary');
    });

    it('returns undefined when the model produced only whitespace', async () => {
        runSpy.mockResolvedValue('   ');
        expect(await svc.generate(pr, 'diff')).toBeUndefined();
    });

    it('is fail-safe: a model error yields undefined (never crashes the demo page)', async () => {
        runSpy.mockRejectedValue(new Error('model down'));
        expect(await svc.generate(pr, 'diff')).toBeUndefined();
    });
});
