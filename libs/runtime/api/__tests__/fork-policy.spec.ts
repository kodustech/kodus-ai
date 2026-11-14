// The generated EE environment file is not part of a fresh worktree; the mapping never reads it.
jest.mock('@libs/ee/configs/environment', () => ({ environment: {} }));

import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { AzureReposService } from '@libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service';

import { decideForkRun, forkPolicyOf, forkRunMaxTokens } from '../domain/fork-policy';
import { CodeManagementRuntimeGitAdapter } from '../infrastructure/code-management-git.adapter';

describe('decideForkRun (ADR-030)', () => {
    const fork = { fork: true };
    const same = { fork: false };

    it('a PR from the same repository starts whatever the policy says', () => {
        for (const policy of ['skip', 'require_approval', 'run', undefined, null, 'bogus']) {
            expect(decideForkRun(policy, same)).toEqual({ start: true, fork: false });
        }
    });

    it('skip: a fork gets no Run, with the reason the trigger reports', () => {
        expect(decideForkRun('skip', fork)).toEqual({ start: false, reason: 'fork_pull_requests_skipped' });
    });

    it('require_approval: a fork Run waits for a maintainer', () => {
        expect(decideForkRun('require_approval', fork)).toEqual({ start: true, fork: true, approvalRequired: true });
    });

    it('run: a fork Run starts without an approval', () => {
        expect(decideForkRun('run', fork)).toEqual({ start: true, fork: true, approvalRequired: false });
    });

    it('an absent or unknown setting is require_approval, never run', () => {
        for (const policy of [undefined, null, '', 'RUN', 1, {}]) {
            expect(forkPolicyOf(policy)).toBe('require_approval');
            expect(decideForkRun(policy, fork)).toEqual({ start: true, fork: true, approvalRequired: true });
        }
    });

    it('a head whose fork flag is not a plain false counts as a fork', () => {
        expect(decideForkRun('run', { fork: undefined as unknown as boolean })).toMatchObject({ fork: true });
    });

    it('the fork budget is a quarter of the per-Run one, at least one token', () => {
        expect(forkRunMaxTokens(200_000)).toBe(50_000);
        expect(forkRunMaxTokens(3)).toBe(1);
    });
});

/**
 * The fork fact compares the head and base repository ids of the PR the
 * integration fetched from the platform (ADR-057), in the shape each
 * provider's mapping gives them.
 */
describe('CodeManagementRuntimeGitAdapter: fork per provider mapping', () => {
    const input = { organizationId: 'o', teamId: 't', repositoryId: '42', repositoryName: 'acme/shop', prNumber: 7 };
    const headOf = async (head: unknown, base: unknown) =>
        new CodeManagementRuntimeGitAdapter({
            getPullRequest: async () => ({
                head: { sha: 'a'.repeat(40), repo: head },
                base: { sha: 'b'.repeat(40), repo: base },
                state: PullRequestState.OPENED,
                user: { id: 9, login: 'dev' },
            }),
        } as any).getPullRequestHead(input);

    it.each([
        // GitHub and Forgejo: pull_request.head.repo.id vs base.repo.id.
        ['github same repo', { id: '42' }, { id: '42' }, false],
        ['github fork', { id: '77' }, { id: '42' }, true],
        // GitLab: source_project_id vs the target project the product stores.
        ['gitlab same project', { id: '42' }, { id: '42' }, false],
        ['gitlab fork project', { id: '901' }, { id: '42' }, true],
        // Bitbucket Cloud and Data Center: source vs destination repository uuid/id.
        ['bitbucket same repo', { id: 'f0e1d2c3' }, { id: 'f0e1d2c3' }, false],
        ['bitbucket fork', { id: 'aa11bb22' }, { id: 'f0e1d2c3' }, true],
        // Numeric and string ids of the same repo are the same repo.
        ['numeric vs string id', { id: 42 }, { id: '42' }, false],
        // The platform did not say: approval is the safe side.
        ['head repo unknown', { id: '' }, { id: '42' }, true],
        ['base repo unknown', { id: '42' }, undefined, true],
        ['no repos at all', undefined, undefined, true],
    ])('%s', async (_name, head, base, fork) => {
        expect((await headOf(head, base))?.fork).toBe(fork);
    });
});

describe('Azure Repos mapping: the head repo of a fork PR is its forkSource', () => {
    const service = new AzureReposService({} as any, {} as any, {} as any, {} as any, {} as any, undefined);
    const transform = (pr: unknown) => (service as any).transformPullRequest(pr, { organizationId: 'o', teamId: 't' });
    const pr = (patch: object = {}) => ({
        pullRequestId: 7,
        status: 'active',
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        repository: { id: 'repo-target', name: 'shop' },
        lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
        lastMergeTargetCommit: { commitId: 'b'.repeat(40) },
        createdBy: { id: 'u1', displayName: 'dev' },
        ...patch,
    });

    it('a PR inside the repository maps the same repo on both sides', () => {
        const out = transform(pr());
        expect(out.head.repo.id).toBe('repo-target');
        expect(out.base.repo.id).toBe('repo-target');
    });

    it('a PR from a fork maps the fork as the head repo, so the Runtime sees a fork', () => {
        const out = transform(pr({ forkSource: { name: 'refs/heads/feature', repository: { id: 'repo-fork', name: 'shop' } } }));
        expect(out.head.repo.id).toBe('repo-fork');
        expect(out.base.repo.id).toBe('repo-target');
    });
});
