import { ForgejoService } from './forgejo.service';

const request = {
    organizationAndTeamData: {
        organizationId: 'org-1',
        teamId: 'team-1',
    },
    repository: { name: 'acme/api' },
    prNumber: 42,
};

it('reports missing Forgejo authentication instead of returning no comments', async () => {
    const service = Object.create(ForgejoService.prototype) as ForgejoService;
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue(null);

    await expect(service.getAllCommentsInPullRequest(request)).rejects.toThrow(
        'Forgejo authentication unavailable',
    );
});

it('reports an unresolvable Forgejo repository instead of returning no comments', async () => {
    const service = Object.create(ForgejoService.prototype) as ForgejoService;
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
    jest.spyOn(service as any, 'extractRepoInfo').mockReturnValue(null);

    await expect(service.getAllCommentsInPullRequest(request)).rejects.toThrow(
        'Forgejo repository unavailable',
    );
});
