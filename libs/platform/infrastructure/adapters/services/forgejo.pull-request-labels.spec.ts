const repoGetPullRequest = jest.fn();
const issueGetIssue = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGetPullRequest: (...args: unknown[]) => repoGetPullRequest(...args),
    issueGetIssue: (...args: unknown[]) => issueGetIssue(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — live PR labels', () => {
    const service = Object.create(ForgejoService.prototype) as ForgejoService;

    beforeEach(() => {
        repoGetPullRequest.mockReset();
        issueGetIssue.mockReset();
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
            configurable: true,
        });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.test',
        });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
        repoGetPullRequest.mockResolvedValue({
            data: { id: 7, number: 7, title: 'Change', state: 'open' },
        });
    });

    it('loads labels from the issue endpoint instead of assuming the PR SDK response has them', async () => {
        issueGetIssue.mockResolvedValue({
            data: { labels: [{ name: 'ready' }, { name: 'security' }] },
        });

        const pr = await service.getPullRequest({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'acme/widget-api' },
            prNumber: 7,
        });

        expect(pr?.labels).toEqual(['ready', 'security']);
        expect(issueGetIssue).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { owner: 'acme', repo: 'widget-api', index: 7 },
            }),
        );
    });

    it('leaves labels unavailable when the issue lookup has no data', async () => {
        issueGetIssue.mockResolvedValue({ error: { status: 503 } });

        const pr = await service.getPullRequest({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'acme/widget-api' },
            prNumber: 7,
        });

        expect(pr?.labels).toBeUndefined();
    });
});
