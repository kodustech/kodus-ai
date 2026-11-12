import { GithubService } from './github.service';

function setup() {
    const stored = new Map<string, any>();
    const cache = {
        getFromCache: jest.fn(async (key) => stored.get(key)),
        addToCache: jest.fn(async (key, value) => {
            stored.set(key, value);
        }),
    };
    const service = new GithubService(
        {} as any,
        {} as any,
        {} as any,
        cache as any,
        { get: () => undefined } as any,
    );
    const pulls = { listFiles: jest.fn(), get: jest.fn() };
    const octokit = { rest: { pulls }, pulls, paginate: jest.fn() };
    jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
        org: 'acme',
    });
    jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(octokit);
    const input = {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
        prNumber: 1,
        headSha: 'head',
        baseSha: 'base',
    };
    return { service, cache, stored, octokit, input };
}

it('never reuses a head-only diff after the PR target changes', async () => {
    const { service, octokit, input } = setup();
    octokit.paginate
        .mockResolvedValueOnce([{ filename: 'old.ts' }])
        .mockResolvedValue([{ filename: 'sensitive/new.ts' }]);
    expect((await service.getFilesByPullRequestId(input))[0].filename).toBe(
        'old.ts',
    );
    expect(
        (
            await service.getFilesByPullRequestId({
                ...input,
                baseSha: 'retargeted',
            })
        )[0].filename,
    ).toBe('sensitive/new.ts');
    expect(
        (
            await service.getFilesByPullRequestId({
                ...input,
                baseSha: 'retargeted',
            })
        )[0].filename,
    ).toBe('sensitive/new.ts');
    expect(octokit.paginate).toHaveBeenCalledTimes(2);
});

it.each(['headSha', 'baseSha'])(
    'bypasses cache without the full ref identity (%s missing)',
    async (field) => {
        const { service, octokit, input, cache } = setup();
        delete input[field];
        octokit.paginate.mockResolvedValue([{ filename: 'a.ts' }]);
        await service.getFilesByPullRequestId(input);
        await service.getFilesByPullRequestId(input);
        expect(cache.getFromCache).not.toHaveBeenCalled();
        expect(cache.addToCache).not.toHaveBeenCalled();
        expect(octokit.paginate).toHaveBeenCalledTimes(2);
    },
);

it('exposes the actual full PR count from the normalized GitHub response', async () => {
    const { service, octokit, input } = setup();
    octokit.rest.pulls.get.mockResolvedValue({
        data: {
            number: 1,
            title: 'Change',
            body: '',
            changed_files: 2,
            head: { sha: 'head' },
            base: { sha: 'base' },
        },
    });
    expect(await service.getPullRequest(input)).toMatchObject({
        changedFilesCount: 2,
        head: { sha: 'head' },
        base: { sha: 'base' },
    });
});
