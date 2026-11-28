const issueEditComment = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    issueEditComment: (...args: unknown[]) => issueEditComment(...args),
}));

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';

/**
 * On Bitbucket, Azure Repos and Forgejo a failed comment edit answered null,
 * whatever the cause: a deleted comment looked like an outage, so the Kody
 * Runtime's PR comment, once deleted by a user, was never posted again
 * (V-09). Asked to fail on error, the edit's failure reaches the caller with
 * its HTTP status. Not asked, it answers null as before (code review).
 */
const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const params = {
    organizationAndTeamData,
    repository: { id: 'repo-1', name: 'acme/widget-api', project: { id: 'project-1' } },
    prNumber: 7,
    commentId: 11,
    body: 'the comment',
};
const gone = Object.assign(new Error('Request failed with status 404'), { status: 404, response: { status: 404 } });

function bare<T>(cls: { prototype: T }): T {
    const service = Object.create(cls.prototype) as T;
    Object.defineProperty(service, 'logger', {
        value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        configurable: true,
    });
    return service;
}

const platforms: Array<[string, () => { updateIssueComment(p: unknown): Promise<unknown> }]> = [
    [
        'Azure Repos',
        () => {
            const service = bare(AzureReposService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({ orgName: 'acme', token: 'tok' });
            jest.spyOn(service as any, 'getProjectIdFromRepository').mockResolvedValue('project-1');
            Object.defineProperty(service, 'azureReposRequestHelper', {
                value: { updateCommentOnPullRequest: jest.fn().mockRejectedValue(gone) },
            });
            return service as any;
        },
    ],
    [
        'Bitbucket Cloud',
        () => {
            const service = bare(BitbucketCloudService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
            jest.spyOn(service as any, 'getWorkspaceFromRepository').mockResolvedValue('ws-1');
            jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
                pullrequests: { updateComment: jest.fn().mockRejectedValue(gone) },
            });
            return service as any;
        },
    ],
    [
        'Bitbucket Data Center',
        () => {
            const service = bare(BitbucketDataCenterService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
            jest.spyOn(service as any, 'getRepoConfig').mockResolvedValue({ workspaceId: 'PRJ', name: 'widget-api' });
            jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({
                get: jest.fn().mockRejectedValue(gone),
                put: jest.fn(),
            });
            return service as any;
        },
    ],
    [
        'Forgejo',
        () => {
            const service = bare(ForgejoService);
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({ host: 'https://git.test' });
            jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
            // The client answers an HTTP error with `{ error }` unless told to throw; thrown, it is the axios error.
            issueEditComment.mockImplementation(async (opts: { throwOnError?: boolean }) => {
                if (opts.throwOnError) throw gone;
                return Object.assign(new Error('Request failed with status 404'), { error: { message: 'not found' }, response: { status: 404 } });
            });
            return service as any;
        },
    ],
];

describe.each(platforms)('a failed comment edit on %s', (_name, make) => {
    beforeEach(() => issueEditComment.mockReset());

    it('reaches the caller with its HTTP status when asked to fail on error', async () => {
        const service = make();
        await expect(service.updateIssueComment({ ...params, failOnError: true })).rejects.toMatchObject({ status: 404 });
    });

    it('answers null when not asked, as code review expects', async () => {
        const service = make();
        await expect(service.updateIssueComment(params)).resolves.toBeFalsy();
    });
});

it('Forgejo reports missing credentials instead of answering null when asked to fail on error', async () => {
    const service = bare(ForgejoService);
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue(null);
    await expect(service.updateIssueComment({ ...params, failOnError: true } as any)).rejects.toThrow(/credentials|unavailable/i);
});
