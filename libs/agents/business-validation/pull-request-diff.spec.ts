import { fitDiff, formatPullRequestDiff } from './pull-request-diff';

describe('fitDiff (UC-32)', () => {
    const diff = formatPullRequestDiff([
        { filename: 'a.ts', patch: '+'.repeat(40) },
        { filename: 'huge.ts', patch: '+'.repeat(500) },
        { filename: 'b.ts', patch: '+'.repeat(40) },
    ]);

    it('keeps a diff under budget whole', () => {
        expect(fitDiff(diff, 10_000)).toEqual({ diff, unseenFiles: [] });
    });

    it('skips a file that does not fit and keeps the smaller ones after it', () => {
        const fitted = fitDiff(diff, 200);
        expect(fitted.unseenFiles).toEqual(['huge.ts']);
        expect(fitted.diff).toContain('=== FILE: a.ts ===');
        expect(fitted.diff).toContain('=== FILE: b.ts ===');
        expect(fitted.diff.length).toBeLessThanOrEqual(200);
    });

    it('reads unified diff headers from a local diff too', () => {
        const local = `diff --git a/x.ts b/x.ts\n${'+'.repeat(300)}\ndiff --git a/y.ts b/y.ts\n+ok\n`;
        expect(fitDiff(local, 100).unseenFiles).toEqual(['x.ts']);
    });
});
