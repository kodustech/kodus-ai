import { toBranchName } from './sandbox.provider';

/**
 * Azure Repos reports `refs/heads/<branch>`. Everything downstream builds
 * `origin/<branch>` from a sandbox's base branch, so an unnormalized value
 * produces `origin/refs/heads/main`, which resolves to nothing — and the
 * dependency scan, which fails closed without a baseline, then reports
 * nothing at all rather than reporting an error.
 */
describe('toBranchName', () => {
    it('strips the ref prefix Azure Repos reports', () => {
        expect(toBranchName('refs/heads/main')).toBe('main');
        expect(toBranchName('refs/heads/feature/a/b')).toBe('feature/a/b');
    });

    it('leaves a bare branch name alone', () => {
        expect(toBranchName('main')).toBe('main');
    });

    it('passes undefined through, so "no base branch" stays distinguishable', () => {
        expect(toBranchName(undefined)).toBeUndefined();
    });

    it('only strips a leading prefix', () => {
        expect(toBranchName('release/refs/heads/x')).toBe('release/refs/heads/x');
    });
});
