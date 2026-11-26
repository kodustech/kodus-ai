import { defaultBranchPushOf } from './default-branch-push';

const SHA = 'a'.repeat(40);
const payload = (patch: Record<string, unknown> = {}) => ({
    ref: 'refs/heads/main',
    after: SHA,
    repository: { default_branch: 'main', fork: false },
    ...patch,
});

describe('a push that moved the default branch', () => {
    it('is a push to the branch the repository names as its default', () => {
        expect(defaultBranchPushOf('push', payload())).toEqual({ branch: 'main', after: SHA });
    });

    it.each([
        ['another branch', payload({ ref: 'refs/heads/feature' })],
        ['a tag of the same name', payload({ ref: 'refs/tags/main' })],
        ['a deletion', payload({ deleted: true, after: '0'.repeat(40) })],
        ['a fork repository', payload({ repository: { default_branch: 'main', fork: true } })],
        ['a repository that names no default branch', payload({ repository: {} })],
        ['a push without a commit', payload({ after: undefined })],
        ['a merge queue branch', payload({ ref: 'refs/heads/gh-readonly-queue/main/pr-4-' + SHA })],
    ])('is not %s', (_label, p) => {
        expect(defaultBranchPushOf('push', p as never)).toBeNull();
    });

    it('is not any other event', () => {
        expect(defaultBranchPushOf('pull_request', payload())).toBeNull();
    });
});
