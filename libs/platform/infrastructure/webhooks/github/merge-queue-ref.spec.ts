import { parseMergeQueueRef } from './merge-queue-ref';

describe('parseMergeQueueRef', () => {
    const base = 'b849a34be3d6e2b91399a6ddca1a4d3ea153839d';

    it('reads the PR number and base branch from a merge queue branch', () => {
        expect(
            parseMergeQueueRef(`refs/heads/gh-readonly-queue/main/pr-1-${base}`),
        ).toEqual({ prNumber: 1, baseBranch: 'main' });
    });

    it('keeps slashes in the base branch', () => {
        expect(
            parseMergeQueueRef(
                `refs/heads/gh-readonly-queue/release/2026.11/pr-345-${base}`,
            ),
        ).toEqual({ prNumber: 345, baseBranch: 'release/2026.11' });
    });

    it.each([
        'refs/heads/main',
        'refs/heads/feature/gh-readonly-queue/main/pr-1-' + base,
        'refs/tags/gh-readonly-queue/main/pr-1-' + base,
        'refs/heads/gh-readonly-queue/main/pr-x-' + base,
        'refs/heads/gh-readonly-queue/main/pr-1-abc',
        undefined,
        '',
    ])('returns null for %p', (ref) => {
        expect(parseMergeQueueRef(ref)).toBeNull();
    });
});
