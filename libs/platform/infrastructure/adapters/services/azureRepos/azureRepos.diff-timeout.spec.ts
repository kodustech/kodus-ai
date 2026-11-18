import { AzureReposService } from './azureRepos.service';

// The diff of one file times out (resolves undefined); the others diff.
jest.mock('./azure-file-patch', () => {
    const actual = jest.requireActual('./azure-file-patch');
    return {
        ...actual,
        createFilePatchYielding: jest.fn(
            (oldName: string, ...rest: unknown[]) =>
                oldName === '/src/huge.ts'
                    ? Promise.resolve(undefined)
                    : (actual.createFilePatchYielding as any)(oldName, ...rest),
        ),
    };
});

describe('AzureReposService.getFilesByPullRequestId — a diff that times out', () => {
    it('leaves that file without a patch (unavailable), never with an empty one', async () => {
        const helper = {
            getPullRequestDetails: jest.fn().mockResolvedValue({
                id: 42,
                lastMergeTargetCommit: { commitId: 'base' },
                lastMergeSourceCommit: { commitId: 'head' },
            }),
            getIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
            getChanges: jest.fn().mockResolvedValue([
                { item: { path: '/src/huge.ts' }, changeType: 'edit' },
                { item: { path: '/src/small.ts' }, changeType: 'edit' },
            ]),
            getFileContent: jest.fn(({ commitId }) => ({
                content: commitId === 'base' ? 'a\nb\n' : 'a\nB\n',
            })),
            mapAzureStatusToFileChangeStatus: jest.fn(() => 'modified'),
        };
        const service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            helper as any,
            {} as any,
            undefined,
        );
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'org',
            token: 'token',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project');
        // The timeout warning is expected; keep the test output quiet.
        jest.spyOn((service as any).logger, 'warn').mockImplementation(
            () => undefined,
        );

        const files = await service.getFilesByPullRequestId({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            repository: { id: 'repo', name: 'repo' },
            prNumber: 42,
        });

        const huge = files?.find((f) => f.filename === '/src/huge.ts');
        const small = files?.find((f) => f.filename === '/src/small.ts');
        // Still listed, so the review knows the file changed ...
        expect(huge).toBeDefined();
        // ... but its patch is unavailable, the same shape providers use for
        // an omitted oversized diff, which risk/approval treat as missing.
        expect(huge?.patch).toBeUndefined();
        expect(small?.patch).toEqual(expect.stringContaining('@@'));
    });
});
