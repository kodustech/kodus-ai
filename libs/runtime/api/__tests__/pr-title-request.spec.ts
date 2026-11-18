import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import type { PullRequestHead } from '../domain/ports';
import { CodeManagementRuntimeGitAdapter } from '../infrastructure/code-management-git.adapter';
import { BASE_SHA, ORG, REPO, SHA, TEAM, clock, config } from './fixtures';

// The product sends the PR title the Git API answered in the Run request: the
// author's untrusted text, at most the message's 1024. The intent classifier
// reads it as data; the Run keeps one clean line of it for display.

describe('the product sends the PR title in the Run request', () => {
    const input = { organizationId: 'o', teamId: 't', repositoryId: '42', repositoryName: 'acme/shop', prNumber: 7 };
    const pr = (patch: any = {}) => ({
        head: { sha: 'a'.repeat(40), repo: { id: 1 } },
        base: { sha: 'b'.repeat(40), repo: { id: 1 } },
        state: PullRequestState.OPENED,
        user: { id: 9, login: 'dev' },
        ...patch,
    });
    const headOf = (patch: any) => new CodeManagementRuntimeGitAdapter({ getPullRequest: async () => pr(patch) } as any).getPullRequestHead(input);

    it('reads the title the Git API answered, as it is', async () => {
        expect(await headOf({ title: 'fix(orders): coupon total' })).toMatchObject({ title: 'fix(orders): coupon total' });
    });

    it("cuts a title longer than the message's bound, never splitting a character", async () => {
        expect((await headOf({ title: 'x'.repeat(5000) }))?.title).toBe('x'.repeat(1024));
        const cut = (await headOf({ title: `${'x'.repeat(1023)}🚀` }))?.title;
        expect(cut).toBe('x'.repeat(1023));
    });

    it.each([undefined, null, '', 42])('omits a title the Git API did not answer (%j)', async (title) => {
        expect(await headOf({ title })).not.toHaveProperty('title');
    });

    const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
    const builder = () =>
        new RuntimeRunRequestBuilder(
            { getPullRequestDiff: async () => ({ files: [], truncated: false }) } as any,
            { issue: async () => 'fixture-token' },
            { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
            config(),
            clock,
        );

    it.each(['fix(orders): coupon total', undefined])('puts the head\'s title in the request, or none (%j)', async (title) => {
        const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, ...(title === undefined ? {} : { title }) };
        const requested = await builder().build({ env, prNumber: 7, head, trigger: 'pull_request' });
        if (title === undefined) expect(requested.pullRequest).not.toHaveProperty('title');
        else expect(requested.pullRequest).toHaveProperty('title', title);
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });
});
