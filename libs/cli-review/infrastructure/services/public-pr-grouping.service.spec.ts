import { LLM } from '@libs/llm/llm';
import { PublicPrGroupingService } from './public-pr-grouping.service';

/**
 * The model proposes file groups; this service defends the result before it
 * reaches the UI: it drops hallucinated paths (files not in the PR), keeps each
 * file in exactly one group, collects anything unassigned into a synthetic
 * "Other changes" group, and degrades to undefined on any failure. Those
 * defenses are the deterministic contract pinned here (the model call is stubbed).
 */
describe('PublicPrGroupingService.generate — post-LLM defense', () => {
    const svc = new PublicPrGroupingService();
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

    it('skips grouping (no model call) for a PR with fewer than 2 files', async () => {
        expect(await svc.generate(pr, 'diff', [])).toBeUndefined();
        expect(await svc.generate(pr, 'diff', ['only.ts'])).toBeUndefined();
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('drops hallucinated file paths that were not in the PR', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: 'A', explanation: 'e', files: ['a.ts', 'invented.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out?.[0].files).toEqual(['a.ts']); // invented.ts dropped
        expect(out?.find((g) => g.title === 'Other changes')?.files).toEqual([
            'b.ts',
        ]);
    });

    it('assigns each file to only the FIRST group that claims it', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: 'First', explanation: 'e', files: ['a.ts'] },
                { title: 'Second', explanation: 'e', files: ['a.ts', 'b.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out?.find((g) => g.title === 'First')?.files).toEqual(['a.ts']);
        expect(out?.find((g) => g.title === 'Second')?.files).toEqual(['b.ts']); // a.ts not duplicated
    });

    it('drops a group left empty after filtering, and trims titles/explanations', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: '  Real  ', explanation: '  desc  ', files: ['a.ts', 'b.ts'] },
                { title: 'Empty', explanation: 'e', files: ['invented.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out).toHaveLength(1); // Empty dropped, no leftovers → just Real
        expect(out?.[0]).toMatchObject({
            title: 'Real',
            explanation: 'desc',
            files: ['a.ts', 'b.ts'],
        });
    });

    it('collects real files that no group claimed into an "Other changes" group', async () => {
        runSpy.mockResolvedValue({
            groups: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts', 'c.ts']);

        expect(out?.find((g) => g.title === 'Other changes')?.files).toEqual([
            'b.ts',
            'c.ts',
        ]);
    });

    it('is fail-safe: an LLM error yields undefined (no grouping rather than a crash)', async () => {
        runSpy.mockRejectedValue(new Error('model down'));
        expect(await svc.generate(pr, 'diff', ['a.ts', 'b.ts'])).toBeUndefined();
    });
});
