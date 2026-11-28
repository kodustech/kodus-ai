import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import type { PullRequestHead } from '../domain/ports';
import { CodeManagementRuntimeGitAdapter } from '../infrastructure/code-management-git.adapter';
import { BASE_SHA, ORG, REPO, SHA, TEAM, clock, config } from './fixtures';

// The product sends the PR description the Git API answered in the Run request:
// the author's untrusted text, at most the message's 65,536. The intent author
// reads it as data, to write the checks of what the PR says it does.

describe('the product sends the PR description in the Run request', () => {
    const input = { organizationId: 'o', teamId: 't', repositoryId: '42', repositoryName: 'acme/shop', prNumber: 7 };
    const pr = (patch: any = {}) => ({
        head: { sha: 'a'.repeat(40), repo: { id: 1 } },
        base: { sha: 'b'.repeat(40), repo: { id: 1 } },
        state: PullRequestState.OPENED,
        user: { id: 9, login: 'dev' },
        ...patch,
    });
    const headOf = (patch: any) => new CodeManagementRuntimeGitAdapter({ getPullRequest: async () => pr(patch) } as any).getPullRequestHead(input);

    it('reads the description the Git API answered, as it is', async () => {
        expect(await headOf({ body: '`charge` must equal `total`.' })).toMatchObject({ description: '`charge` must equal `total`.' });
    });

    it("cuts a description longer than the message's bound, never splitting a character", async () => {
        expect((await headOf({ body: 'x'.repeat(70_000) }))?.description).toBe('x'.repeat(65_536));
        expect((await headOf({ body: `${'x'.repeat(65_535)}🚀` }))?.description).toBe('x'.repeat(65_535));
    });

    it.each([undefined, null, '', '   ', 42])('omits a description the Git API did not answer (%j)', async (body) => {
        expect(await headOf({ body })).not.toHaveProperty('description');
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

    it.each(['`charge` must equal `total`.', undefined])("puts the head's description in the request, or none (%j)", async (description) => {
        const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, ...(description === undefined ? {} : { description }) };
        const requested = await builder().build({ env, prNumber: 7, head, trigger: 'pull_request' });
        if (description === undefined) expect(requested.pullRequest).not.toHaveProperty('description');
        else expect(requested.pullRequest).toHaveProperty('description', description);
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(true);
    });
});
